import { submitDocumentCommand } from "../api";
import { shareProjectKey } from "../shareMode";
import { isClientRejection, isRetryLater } from "../utils/apiError";
import {
  hostSendDone,
  hostSendsFinished,
  trackHostDrain,
} from "./hostSendOrder";
import {
  loadCommandQueue,
  loadHostCommandQueue,
  removeHostQueuedCommands,
} from "./offlineStore";

/** Drain persisted share-guest commands in client_seq order after reconnect. */
export async function drainOfflineQueue(token: string): Promise<void> {
  const queue = [...(await loadCommandQueue(token))].sort(
    (a, b) => a.client_seq - b.client_seq,
  );
  const path = shareProjectKey(token);
  for (const cmd of queue) {
    try {
      await submitDocumentCommand(path, cmd.type, cmd.payload, {
        command_id: cmd.command_id,
        client_id: cmd.client_id,
        client_seq: cmd.client_seq,
        structural_mode: cmd.structural_mode,
        replaying: true,
      });
    } catch (error) {
      // A refused replay was recorded as a conflict and dequeued, so later
      // edits still drain. A rate limit, server or network error stays
      // queued and keeps order until the next drain.
      if (isClientRejection(error) && !isRetryLater(error)) {
        continue;
      }
      break;
    }
  }
}

/** In-flight live sends a drain already waits on: repeated drains add no second wake-up. */
const awaitedLiveSends = new Set<string>();

/** Drain persisted host commands in insertion order after reconnect. */
export async function drainHostOfflineQueue(
  projectPath: string,
): Promise<void> {
  // Read before the snapshot, so a send that finishes while it loads counts.
  let finishedSeen = hostSendsFinished(projectPath);
  const queue = await loadHostCommandQueue(projectPath);
  const completed: string[] = [];
  // Live sends use fresh command ids, so a live send can dequeue only a
  // snapshot record it was already sending. Live edits made during a long
  // replay append after the snapshot and never force a re-read.
  const sentLive = new Set(
    queue
      .map((c) => c.command_id)
      .filter((id) => hostSendDone(projectPath, id) !== null),
  );
  // A send that finished while the snapshot loaded may have dequeued any record.
  let recheckAll = hostSendsFinished(projectPath) !== finishedSeen;
  let present: Set<string> | null = null;
  for (const cmd of queue) {
    // This tab is still POSTing it live: replaying now would send it twice.
    // Stop to keep order, and drain again once that send settles.
    const live = hostSendDone(projectPath, cmd.command_id);
    if (live) {
      if (!awaitedLiveSends.has(cmd.command_id)) {
        awaitedLiveSends.add(cmd.command_id);
        void live.then(() => {
          awaitedLiveSends.delete(cmd.command_id);
          return requestHostDrain(projectPath);
        });
      }
      break;
    }
    // Re-read only when a live send that may have removed this record has
    // finished since the last read: each read loads every queued payload.
    if (
      (recheckAll || sentLive.has(cmd.command_id)) &&
      hostSendsFinished(projectPath) !== finishedSeen
    ) {
      finishedSeen = hostSendsFinished(projectPath);
      recheckAll = false;
      try {
        present = new Set(
          (await loadHostCommandQueue(projectPath)).map((c) => c.command_id),
        );
      } catch {
        // Unreadable queue: stop this pass but still remove what already
        // committed below; the next drain retries the rest in order.
        break;
      }
    }
    if (present && !present.has(cmd.command_id)) {
      continue;
    }
    try {
      const result = await submitDocumentCommand(
        projectPath,
        cmd.type,
        cmd.payload,
        {
          command_id: cmd.command_id,
          client_id: cmd.client_id,
          client_seq: cmd.client_seq,
          structural_mode: cmd.structural_mode,
          replaying: true,
        },
      );
      if (result.queued === true) {
        break;
      }
      completed.push(cmd.command_id);
    } catch (error) {
      // A 4xx was already recorded as a conflict and dequeued; later,
      // unrelated edits must still drain. Network errors / 5xx keep order.
      if (isClientRejection(error)) {
        continue;
      }
      break;
    }
  }
  // One persisted update replaces N full-array rewrites on a long replay.
  await removeHostQueuedCommands(projectPath, completed);
}

const hostDrainRuns = new Map<
  string,
  { again: boolean; done: Promise<void> }
>();

/**
 * Drain the host queue now, or once more after the drain in progress, so a
 * request made mid-drain is never lost. Never rejects.
 */
export function requestHostDrain(projectPath: string): Promise<void> {
  const running = hostDrainRuns.get(projectPath);
  if (running) {
    running.again = true;
    return running.done;
  }
  const run = { again: false, done: Promise.resolve() };
  hostDrainRuns.set(projectPath, run);
  run.done = (async () => {
    try {
      do {
        run.again = false;
        await drainHostOfflineQueue(projectPath).catch(() => undefined);
      } while (run.again);
    } finally {
      hostDrainRuns.delete(projectPath);
    }
  })();
  trackHostDrain(projectPath, run.done);
  return run.done;
}
