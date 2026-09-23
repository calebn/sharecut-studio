import { type ByteSink, keeperMetaComplete, keeperMetaPath } from "./store";

/** Host status fields the reclaim policy reads (a subset of the upload row). */
export type ReclaimStatusRow = {
  file_ack?: boolean;
  landed?: boolean;
  land_failed?: boolean;
};

/**
 * Pure retention policy: a finalized keeper WAV may be deleted only after a
 * fresh host status confirms `file_ack` and successful landing, and never
 * while the current take could still be capturing into it.
 */
export function canReclaimKeeperSegment(args: {
  remoteSeg: ReclaimStatusRow | undefined;
  take: number;
  takeIndex: number;
  settled: boolean;
}): boolean {
  const { remoteSeg, take, takeIndex, settled } = args;
  if (!remoteSeg?.file_ack || !remoteSeg.landed || remoteSeg.land_failed) {
    return false;
  }
  return take < takeIndex || (take === takeIndex && settled);
}

/** Consecutive delete failures before the UI is told reclaim is stuck. */
export const KEEPER_RECLAIM_MAX_FAILURES = 3;

export type KeeperReclaimTracker = {
  reclaimed: Set<string>;
  failures: Map<string, number>;
};

export function createKeeperReclaimTracker(): KeeperReclaimTracker {
  return { reclaimed: new Set(), failures: new Map() };
}

export function keeperReclaimStuck(tracker: KeeperReclaimTracker): boolean {
  for (const count of tracker.failures.values()) {
    if (count >= KEEPER_RECLAIM_MAX_FAILURES) {
      return true;
    }
  }
  return false;
}

const holds = new WeakMap<ByteSink, number>();
const inflight = new WeakMap<ByteSink, Set<Promise<unknown>>>();

export function keeperReclaimHeld(sink: ByteSink): boolean {
  return (holds.get(sink) ?? 0) > 0;
}

/**
 * Pause reclaim on `sink` (e.g. while recovery archives OPFS `File`s that are
 * read lazily) and wait for any delete already in flight. Returns an
 * idempotent release.
 */
export async function holdKeeperReclaim(sink: ByteSink): Promise<() => void> {
  holds.set(sink, (holds.get(sink) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    const next = (holds.get(sink) ?? 1) - 1;
    if (next > 0) {
      holds.set(sink, next);
    } else {
      holds.delete(sink);
    }
  };
  const pending = inflight.get(sink);
  if (pending?.size) {
    await Promise.allSettled([...pending]);
  }
  return release;
}

export type KeeperReclaimResult = "reclaimed" | "skipped" | "held" | "failed";

/**
 * Delete a landed keeper WAV, keeping its completion `.json` as the segment
 * identity marker. Requires a completion marker (`complete !== false`), is
 * idempotent via `tracker`, respects {@link holdKeeperReclaim}, and counts
 * consecutive failures so a stuck delete can be surfaced.
 */
export async function reclaimKeeperWav(
  sink: ByteSink,
  wavPath: string,
  tracker: KeeperReclaimTracker,
): Promise<KeeperReclaimResult> {
  if (tracker.reclaimed.has(wavPath)) {
    return "skipped";
  }
  if (keeperReclaimHeld(sink)) {
    return "held";
  }
  if (!keeperMetaComplete(await sink.read(keeperMetaPath(wavPath)))) {
    return "skipped";
  }
  // Re-check synchronously before registering the delete so a hold taken
  // during the metadata read either blocks it or waits for it.
  if (keeperReclaimHeld(sink)) {
    return "held";
  }
  const op = sink.remove(wavPath);
  let ops = inflight.get(sink);
  if (!ops) {
    ops = new Set();
    inflight.set(sink, ops);
  }
  ops.add(op);
  try {
    await op;
    tracker.reclaimed.add(wavPath);
    tracker.failures.delete(wavPath);
    return "reclaimed";
  } catch {
    tracker.failures.set(wavPath, (tracker.failures.get(wavPath) ?? 0) + 1);
    return "failed";
  } finally {
    ops.delete(op);
  }
}
