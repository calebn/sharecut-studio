/**
 * Live host sends started by this tab, per project.
 *
 * A live command is persisted to the host queue before it is POSTed and leaves
 * it only after the response. A second live command therefore sees the first
 * as a queue predecessor even though nothing is offline. This registry lets it
 * tell its own tab's in-flight send apart from real leftovers.
 * It also publishes the host drain run in progress, which a live command waits for as well.
 * Per tab only: another tab's in-flight record looks like an offline leftover, and the caller requests a drain.
 */
interface Send {
  commandId: string;
  done: Promise<void>;
}

import type { HistoryEntryId } from "../types/project";
import { raceTimeout } from "../utils/raceTimeout";

const sends = new Map<string, Send[]>();
const finishedCount = new Map<string, number>();
const drains = new Map<string, Promise<void>>();
const preparing = new Map<string, Set<Promise<void>>>();
const landed = new Map<string, { count: number; head: HistoryEntryId }>();

/**
 * Publish the host drain run in progress (`requestHostDrain`). Its replays are
 * not live sends, and it removes replayed records only when a pass ends, so a
 * live command queued behind them waits for the run too. `done` never rejects.
 */
export function trackHostDrain(projectPath: string, done: Promise<void>): void {
  drains.set(projectPath, done);
  void done.then(() => {
    if (drains.get(projectPath) === done) drains.delete(projectPath);
  });
}

/** The host drain run in progress for the project, or null. */
export function activeHostDrain(projectPath: string): Promise<void> | null {
  return drains.get(projectPath) ?? null;
}

/**
 * How many live sends this tab has finished for the project. It changes only
 * after a send's own queue cleanup, so the drain re-reads the queue only then.
 */
export function hostSendsFinished(projectPath: string): number {
  return finishedCount.get(projectPath) ?? 0;
}

/** How long a live host command waits behind this tab's earlier sends before it stays queued for the drain. */
export const HOST_SEND_WAIT_MS = 5_000;

export interface HostSend {
  /**
   * Settles once every send begun earlier for this project has finished (all of
   * them, not only queue records ahead; the host queue is a single FIFO).
   */
  earlier: Promise<void>;
  /** True once every earlier send and then the host drain run in progress (if any) finished, false if `ms` passes first. */
  earlierWithin: (ms: number) => Promise<boolean>;
  /** Mark this send finished (call from a finally block). */
  finish: () => void;
}

export function beginHostSend(
  projectPath: string,
  commandId: string,
): HostSend {
  const list = sends.get(projectPath) ?? [];
  const earlier = Promise.all(list.map((s) => s.done)).then(() => undefined);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const entry: Send = { commandId, done };
  sends.set(projectPath, [...list, entry]);
  return {
    earlier,
    earlierWithin: (ms) =>
      raceTimeout(
        earlier.then(() => activeHostDrain(projectPath)).then(() => true),
        ms,
        () => false,
      ),
    finish: () => {
      const rest = (sends.get(projectPath) ?? []).filter((s) => s !== entry);
      if (rest.length > 0) sends.set(projectPath, rest);
      else sends.delete(projectPath);
      finishedCount.set(projectPath, hostSendsFinished(projectPath) + 1);
      resolveDone();
    },
  };
}

/** This tab's in-flight live send of `commandId`, settling when it finishes; null if none. */
export function hostSendDone(
  projectPath: string,
  commandId: string,
): Promise<void> | null {
  return (
    (sends.get(projectPath) ?? []).find((s) => s.commandId === commandId)
      ?.done ?? null
  );
}

/**
 * Marks an edit save that does work before its send (loading a boundary
 * token) as in flight for the project until `save` settles. Returns `save`.
 * A history move waits behind it (`editSavesInFlight`), so Undo reverts the
 * edit the person just made, not the one before it.
 */
export function trackEditSave<T>(
  projectPath: string,
  save: Promise<T>,
): Promise<T> {
  const open = preparing.get(projectPath) ?? new Set<Promise<void>>();
  preparing.set(projectPath, open);
  const settled = save.then(
    () => undefined,
    () => undefined,
  );
  open.add(settled);
  void settled.then(() => {
    open.delete(settled);
    if (open.size === 0 && preparing.get(projectPath) === open) {
      preparing.delete(projectPath);
    }
  });
  return save;
}

/**
 * Settles once every edit save this tab has in flight for the project, as of
 * now, has finished: the ones preparing their send (`trackEditSave`) and the
 * live sends begun. Saves that begin later are not waited for.
 */
export function editSavesInFlight(projectPath: string): Promise<void> {
  const open = [
    ...(preparing.get(projectPath) ?? []),
    ...(sends.get(projectPath) ?? []).map((s) => s.done),
  ];
  return Promise.all(open).then(() => undefined);
}

/** Records the history head one of this tab's own commands left, read from its reply. */
export function noteSaveLanded(projectPath: string, head: HistoryEntryId) {
  landed.set(projectPath, {
    count: (landed.get(projectPath)?.count ?? 0) + 1,
    head,
  });
}

/** A mark for `headLandedSince`: how many own commands have landed so far. */
export function savesLandedMark(projectPath: string): number {
  return landed.get(projectPath)?.count ?? 0;
}

/** The head the latest own command left since `mark`; null if none landed. */
export function headLandedSince(
  projectPath: string,
  mark: number,
): HistoryEntryId | null {
  const latest = landed.get(projectPath);
  return latest && latest.count > mark ? latest.head : null;
}
