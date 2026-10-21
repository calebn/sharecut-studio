import { submitDocumentCommand } from "../../api";
import { clearSupersededCorrectionConflicts } from "../../api/documentEdits";
import { shareProjectKey } from "../../shareMode";
import {
  documentSendDone,
  documentSendsFinished,
  trackDocumentDrain,
} from "../../state/documentSendOrder";
import {
  loadCommandQueue,
  loadHostCommandQueue,
  type QueuedCommand,
  removeHostQueuedCommands,
  removeQueuedCommands,
} from "../../state/offlineStore";
import type { DocumentCommandType } from "../../types/documentCommands.generated";
import { isPermanentRejection } from "../../utils/apiError";
import { reconcileCommandBeforeReplay } from "../commandQueue";

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
  /** Check queue membership and in-flight sends before replay. */
  gate?: (cmd: QueuedCommand) => Promise<ReplayGate>;
  /** Runs once when the pass ends, even after a stop, with the committed ids in order. */
  settle?: (completed: string[]) => Promise<void>;
}

/**
 * Replays queued records in order with their original identities. History
 * commands remain inspect-only. Uncertain submissions stay queued and stop
 * the pass so later edits cannot overtake them.
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
    const outcomeGate = await reconcileCommandBeforeReplay(source.path, cmd);
    if (outcomeGate === "stop") break;
    if (outcomeGate === "skip") continue;
    try {
      const result = await submitDocumentCommand(
        source.path,
        // Persisted name; the server's command union rejects one it no longer knows.
        cmd.type as DocumentCommandType,
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
      // A landed correction supersedes earlier refusals of the same word (#746).
      await clearSupersededCorrectionConflicts(
        source.path,
        cmd.type,
        cmd.payload,
      );
    } catch (error) {
      if (isPermanentRejection(error)) continue;
      break;
    }
  }
  await source.settle?.(completed);
}

/**
 * In-flight live sends a drain already waits on, keyed by project and command
 * id (`liveSendKey`): repeated drains add no second wake-up.
 */
const awaitedLiveSends = new Set<string>();

function liveSendKey(projectPath: string, commandId: string): string {
  return `${projectPath}\u0000${commandId}`;
}

/**
 * One persisted queue (host project or share guest) with the calls a replay
 * pass needs. `path` is the project key live sends and drains are tracked under.
 */
interface QueueNamespace {
  path: string;
  load: () => Promise<QueuedCommand[]>;
  remove: (commandIds: string[]) => Promise<void>;
  requestDrain: () => Promise<void>;
}

function hostNamespace(projectPath: string): QueueNamespace {
  return {
    path: projectPath,
    load: () => loadHostCommandQueue(projectPath),
    remove: (ids) => removeHostQueuedCommands(projectPath, ids),
    requestDrain: () => requestHostDrain(projectPath),
  };
}

function guestNamespace(token: string): QueueNamespace {
  return {
    path: shareProjectKey(token),
    load: () => loadCommandQueue(token),
    remove: (ids) => removeQueuedCommands(token, ids),
    requestDrain: () => requestGuestDrain(token),
  };
}

/**
 * Records replay in insertion order, coordinated with this tab's live sends,
 * and are removed in one batch when the pass ends (a guest replay also removes
 * its own row as it lands). Host and guest queues share this policy.
 */
function queueReplaySource(ns: QueueNamespace): ReplaySource {
  const projectPath = ns.path;
  let finishedSeen = 0;
  let sentLive = new Set<string>();
  let recheckAll = false;
  let present: Set<string> | null = null;
  return {
    path: projectPath,
    load: async () => {
      // Read before the snapshot, so a send that finishes while it loads counts.
      finishedSeen = documentSendsFinished(projectPath);
      const queue = await ns.load();
      // Live sends use fresh command ids, so a live send can dequeue only a
      // snapshot record it was already sending. Live edits made during a long
      // replay append after the snapshot and never force a re-read.
      sentLive = new Set(
        queue
          .map((c) => c.command_id)
          .filter((id) => documentSendDone(projectPath, id) !== null),
      );
      // A send that finished while the snapshot loaded may have dequeued any record.
      recheckAll = documentSendsFinished(projectPath) !== finishedSeen;
      return queue;
    },
    gate: async (cmd) => {
      // This tab is still POSTing it live: replaying now would send it twice.
      // Stop to keep order, and drain again once that send settles.
      const live = documentSendDone(projectPath, cmd.command_id);
      if (live) {
        const key = liveSendKey(projectPath, cmd.command_id);
        if (!awaitedLiveSends.has(key)) {
          awaitedLiveSends.add(key);
          void live.then(() => {
            awaitedLiveSends.delete(key);
            return ns.requestDrain();
          });
        }
        return "stop";
      }
      // Re-read only when a live send that may have removed this record has
      // finished since the last read: each read loads every queued payload.
      if (
        (recheckAll || sentLive.has(cmd.command_id)) &&
        documentSendsFinished(projectPath) !== finishedSeen
      ) {
        finishedSeen = documentSendsFinished(projectPath);
        recheckAll = false;
        try {
          present = new Set((await ns.load()).map((c) => c.command_id));
        } catch {
          // Unreadable queue: stop this pass but still remove what already
          // committed; the next drain retries the rest in order.
          return "stop";
        }
      }
      if (present && !present.has(cmd.command_id)) return "skip";
      return "send";
    },
    // One persisted update replaces N full-array rewrites on a long replay.
    settle: (completed) => ns.remove(completed),
  };
}

/**
 * Drain persisted share-guest commands in stored insertion order after
 * reconnect. `client_seq` numbers one client's edits and restarts with each
 * tab, so it does not order rows from different clients.
 */
export function drainOfflineQueue(token: string): Promise<void> {
  return replayQueuedCommands(queueReplaySource(guestNamespace(token)));
}

/** Drain persisted host commands in insertion order after reconnect. */
export function drainHostOfflineQueue(projectPath: string): Promise<void> {
  return replayQueuedCommands(queueReplaySource(hostNamespace(projectPath)));
}

type DrainRun = { again: boolean; done: Promise<void> };

/**
 * Run `pass` now, or once more after the run in progress for `key`, so a
 * request made mid-run is never lost and overlapping requests never run two
 * passes at once. Never rejects.
 *
 * `waveform/statusStore.ts` (`poll`) keeps its own `again` flag: it is an
 * abortable backoff poller, not an ordered replay. If a third "one more pass
 * when asked mid-run" loop appears, extract a shared runner (for example
 * `utils/coalescedRun.ts`) and move all three onto it instead of copying it.
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

const drainRuns = new Map<string, DrainRun>();

function requestQueueDrain(
  path: string,
  pass: () => Promise<void>,
): Promise<void> {
  const { done, started } = coalescedDrain(drainRuns, path, pass);
  if (started) {
    trackDocumentDrain(path, done);
  }
  return done;
}

/**
 * Drain the host queue now, or once more after the drain in progress, so a
 * request made mid-drain is never lost. Never rejects.
 */
export function requestHostDrain(projectPath: string): Promise<void> {
  return requestQueueDrain(projectPath, () =>
    drainHostOfflineQueue(projectPath),
  );
}

/**
 * Replay this share guest's queue now, or once more after the replay in
 * progress: WebSocket reconnect, `online` and the sanity timer can fire
 * together, and two overlapping passes would POST every record twice. Never
 * rejects.
 */
export function requestGuestDrain(token: string): Promise<void> {
  return requestQueueDrain(shareProjectKey(token), () =>
    drainOfflineQueue(token),
  );
}
