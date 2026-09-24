import { keeperReclaimHeld, removeKeeperUnlessHeld } from "./deletionGuard";
import { keeperFileFingerprint } from "./fingerprint";
import { type ByteSink, keeperMetaPath, parseKeeperMeta } from "./store";

export { holdKeeperReclaim, keeperReclaimHeld } from "./deletionGuard";

/** Host status fields the reclaim policy reads (a subset of the upload row). */
export type ReclaimStatusRow = {
  file_ack?: boolean;
  landed?: boolean;
  land_failed?: boolean;
  file_sha256?: string | null;
  byte_length?: number | null;
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
/** A stuck delete is retried after a pause, with a fresh full verification. */
export const KEEPER_RECLAIM_RETRY_MS = 30_000;

export type KeeperReclaimTracker = {
  reclaimed: Set<string>;
  failures: Map<string, number>;
  /** Only failed comparisons are memoized; never authorize deletion from cache. */
  mismatches: Map<string, string>;
  failedDeletes: Map<string, { identity: string; retryAt: number }>;
  fileVersions: Map<string, string>;
};

export function createKeeperReclaimTracker(): KeeperReclaimTracker {
  return {
    reclaimed: new Set(),
    failures: new Map(),
    mismatches: new Map(),
    failedDeletes: new Map(),
    fileVersions: new Map(),
  };
}

export function keeperReclaimStuck(tracker: KeeperReclaimTracker): boolean {
  for (const count of tracker.failures.values()) {
    if (count >= KEEPER_RECLAIM_MAX_FAILURES) {
      return true;
    }
  }
  return false;
}

export type KeeperReclaimResult =
  | "reclaimed"
  | "skipped"
  | "held"
  | "failed"
  | "mismatch";

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
  remoteSeg: ReclaimStatusRow,
): Promise<KeeperReclaimResult> {
  if (tracker.reclaimed.has(wavPath)) {
    return "skipped";
  }
  if (keeperReclaimHeld(sink)) {
    return "held";
  }
  const meta = parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)));
  if (!meta || meta.complete === false) {
    return "skipped";
  }
  const expectedHash = remoteSeg.file_sha256;
  const expectedLength = remoteSeg.byte_length;
  const blob = await sink.readBlob?.(wavPath);
  const missing = async () =>
    sink.readBlob ? !blob : !(await sink.read(wavPath));
  if (!meta.fileSha256 || meta.byteLength == null) {
    if (await missing()) {
      tracker.reclaimed.add(wavPath);
      return "skipped";
    }
    return "mismatch";
  }
  if (
    !expectedHash ||
    expectedLength == null ||
    meta.byteLength !== expectedLength ||
    meta.fileSha256 !== expectedHash
  ) {
    if (await missing()) {
      tracker.reclaimed.add(wavPath);
      return "skipped";
    }
    return "mismatch";
  }
  // A complete marker outlives a successfully reclaimed WAV. A fresh tracker
  // after reload must not report that marker as local/host disagreement.
  // File.lastModified + size is the OPFS file version. If a custom sink lacks
  // that version, it must hash again rather than trust a cached mismatch.
  const lastModified = (blob as File | undefined)?.lastModified;
  const identity =
    blob &&
    typeof lastModified === "number" &&
    Number.isFinite(lastModified) &&
    lastModified > 0
      ? `${blob.size}:${lastModified}:${meta.fileSha256}:${meta.byteLength}:${expectedHash}:${expectedLength}`
      : null;
  if (identity && tracker.mismatches.get(wavPath) === identity) {
    return "mismatch";
  }
  if (identity) {
    const priorVersion = tracker.fileVersions.get(wavPath);
    if (priorVersion && priorVersion !== identity) {
      tracker.failures.delete(wavPath);
      tracker.failedDeletes.delete(wavPath);
    }
    tracker.fileVersions.set(wavPath, identity);
    const failed = tracker.failedDeletes.get(wavPath);
    if (failed?.identity === identity && Date.now() < failed.retryAt) {
      return "failed";
    }
  }
  const fingerprint = await keeperFileFingerprint(
    sink,
    wavPath,
    blob ?? undefined,
  );
  if (!fingerprint) {
    tracker.reclaimed.add(wavPath);
    return "skipped";
  }
  if (
    fingerprint.byteLength !== expectedLength ||
    fingerprint.fileSha256 !== expectedHash
  ) {
    if (identity) tracker.mismatches.set(wavPath, identity);
    return "mismatch";
  }
  tracker.mismatches.delete(wavPath);
  // Re-check synchronously before registering the delete so a hold taken
  // during the metadata read either blocks it or waits for it.
  if (keeperReclaimHeld(sink)) {
    return "held";
  }
  try {
    if ((await removeKeeperUnlessHeld(sink, wavPath)) === "held") return "held";
    tracker.reclaimed.add(wavPath);
    tracker.failures.delete(wavPath);
    tracker.failedDeletes.delete(wavPath);
    return "reclaimed";
  } catch {
    const count = (tracker.failures.get(wavPath) ?? 0) + 1;
    tracker.failures.set(wavPath, count);
    if (identity && count >= KEEPER_RECLAIM_MAX_FAILURES) {
      tracker.failedDeletes.set(wavPath, {
        identity,
        retryAt: Date.now() + KEEPER_RECLAIM_RETRY_MS,
      });
    }
    return "failed";
  }
}
