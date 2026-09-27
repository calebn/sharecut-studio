import { submitDocumentCommand } from "../api";
import { shareProjectKey } from "../shareMode";
import { isPermanentRejection } from "../utils/apiError";
import {
  hostSendDone,
  hostSendsFinished,
  trackHostDrain,
} from "./hostSendOrder";
import {
  loadCommandQueue,
  loadHostCommandQueue,
  type QueuedCommand,
  removeHostQueuedCommands,
} from "./offlineStore";

/** What a pass does with one record just before it would send it. */
export type ReplayGate = "send" | "skip" | "stop";

/**
 * One queue namespace's replay policy for `replayQueuedCommands`. Build a
 * fresh source per pass: it may keep per-pass state between `load` and `gate`.
 */
export interface ReplaySource {
  /** Project key replays are submitted to (`share:{token}` or the host project path). */
  path: string;
  /** The persisted records, in replay order. */
  load: () => Promise<QueuedCommand[]>;
  /** Send, skip or stop at `cmd` (default: send). */
  gate?: (cmd: QueuedCommand) => Promise<ReplayGate>;
  /** Runs once when the pass ends, even after a stop, with the committed ids in order. */
  settle?: (completed: string[]) => Promise<void>;
}

/**
 * The one ordered-replay driver for both offline queues. Each record is
 * re-sent with its original identity (`command_id`, `client_id`,
 * `client_seq`) and `replaying: true`. A permanent rejection
 * (`isPermanentRejection`: a 4xx other than 408 / 429) is skipped. That is
 * only safe because both submit layers (`services/commandQueue.ts`) have
 * already recorded it as a conflict and dequeued it before they throw;
 * `drainOfflineQueue.integration.test.ts` pins this. Anything else
 * (transport error, 408 / 429, 5xx, a replay the submit layer left queued)
 * stays queued and stops the pass, so no later edit overtakes it.
 */
export async function replayQueuedCommands(
  source: ReplaySource,
): Promise<void> {
  const queue = await source.load();
  const completed: string[] = [];
  for (const cmd of queue) {
    const gate = source.gate ? await source.gate(cmd) : "send";
    if (gate === "stop") break;
    if (gate === "skip") continue;
    try {
      const result = await submitDocumentCommand(
        source.path,
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
      if (result.queued === true) break;
      completed.push(cmd.command_id);
    } catch (error) {
      if (isPermanentRejection(error)) continue;
      break;
    }
  }
  await source.settle?.(completed);
}

/** Share-guest records replay in client_seq order; each success dequeues itself. */
function guestReplaySource(token: string): ReplaySource {
  return {
    path: shareProjectKey(token),
    load: async () =>
      [...(await loadCommandQueue(token))].sort(
        (a, b) => a.client_seq - b.client_seq,
      ),
  };
}

/** In-flight live sends a drain already waits on: repeated drains add no second wake-up. */
const awaitedLiveSends = new Set<string>();

/**
 * Host records replay in insertion order, coordinated with this tab's live
 * sends, and are removed in one batch when the pass ends.
 */
function hostReplaySource(projectPath: string): ReplaySource {
  let finishedSeen = 0;
  let sentLive = new Set<string>();
  let recheckAll = false;
  let present: Set<string> | null = null;
  return {
    path: projectPath,
    load: async () => {
      // Read before the snapshot, so a send that finishes while it loads counts.
      finishedSeen = hostSendsFinished(projectPath);
      const queue = await loadHostCommandQueue(projectPath);
      // Live sends use fresh command ids, so a live send can dequeue only a
      // snapshot record it was already sending. Live edits made during a long
      // replay append after the snapshot and never force a re-read.
      sentLive = new Set(
        queue
          .map((c) => c.command_id)
          .filter((id) => hostSendDone(projectPath, id) !== null),
      );
      // A send that finished while the snapshot loaded may have dequeued any record.
      recheckAll = hostSendsFinished(projectPath) !== finishedSeen;
      return queue;
    },
    gate: async (cmd) => {
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
        return "stop";
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
          // committed; the next drain retries the rest in order.
          return "stop";
        }
      }
      return present && !present.has(cmd.command_id) ? "skip" : "send";
    },
    // One persisted update replaces N full-array rewrites on a long replay.
    settle: (completed) => removeHostQueuedCommands(projectPath, completed),
  };
}

/** Drain persisted share-guest commands in client_seq order after reconnect. */
export function drainOfflineQueue(token: string): Promise<void> {
  return replayQueuedCommands(guestReplaySource(token));
}

/** Drain persisted host commands in insertion order after reconnect. */
export function drainHostOfflineQueue(projectPath: string): Promise<void> {
  return replayQueuedCommands(hostReplaySource(projectPath));
}

type DrainRun = { again: boolean; done: Promise<void> };

/**
 * Run `pass` now, or once more after the run in progress for `key`, so a
 * request made mid-run is never lost and overlapping requests never run two
 * passes at once. Never rejects.
 */
function coalescedDrain(
  runs: Map<string, DrainRun>,
  key: string,
  pass: () => Promise<void>,
): { done: Promise<void>; started: boolean } {
  const running = runs.get(key);
  if (running) {
    running.again = true;
    return { done: running.done, started: false };
  }
  const run: DrainRun = { again: false, done: Promise.resolve() };
  runs.set(key, run);
  run.done = (async () => {
    try {
      do {
        run.again = false;
        await pass().catch(() => undefined);
      } while (run.again);
    } finally {
      runs.delete(key);
    }
  })();
  return { done: run.done, started: true };
}

const hostDrainRuns = new Map<string, DrainRun>();
const guestDrainRuns = new Map<string, DrainRun>();

/**
 * Drain the host queue now, or once more after the drain in progress, so a
 * request made mid-drain is never lost. Never rejects.
 */
export function requestHostDrain(projectPath: string): Promise<void> {
  const { done, started } = coalescedDrain(hostDrainRuns, projectPath, () =>
    drainHostOfflineQueue(projectPath),
  );
  if (started) {
    trackHostDrain(projectPath, done);
  }
  return done;
}

/**
 * Replay this share guest's queue now, or once more after the replay in
 * progress: WebSocket reconnect and `online` can fire together, and two
 * overlapping passes would POST every record twice. Never rejects.
 */
export function requestGuestDrain(token: string): Promise<void> {
  return coalescedDrain(guestDrainRuns, token, () => drainOfflineQueue(token))
    .done;
}
