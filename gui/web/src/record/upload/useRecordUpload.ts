import { useEffect, useInsertionEffect, useRef, useState } from "react";
import { errorMessage } from "../../utils/apiError";
import {
  canReclaimKeeperSegment,
  createKeeperReclaimTracker,
  keeperReclaimStuck,
  reclaimKeeperWav,
} from "../keeper/reclaim";
import {
  type ByteSink,
  keeperSegmentPaths,
  pruneExpiredKeeperWavs,
} from "../keeper/store";
import { mergeSegmentSaves, type SegmentSave } from "../saveStatus";
import { UPLOAD_STALLED_COPY } from "../types";
import { RECORD_UPLOAD_WAV_HEADER } from "./chunker";
import { uploadKeeperWav } from "./pump";
import { inspectKeeperRecovery } from "./recovery";
import type { RecordUploadStatus, RecordUploadTransport } from "./transport";

export type RecordUploadProgress = {
  acked: number;
  total: number;
  fileAck: boolean;
  landed: boolean;
  landFailed: boolean;
  /** Landed keeper WAVs could not be deleted after repeated attempts. */
  reclaimFailed: boolean;
  /** Local WAV, metadata, and landed host fingerprint do not agree. */
  reclaimMismatch?: boolean;
  uploading: boolean;
  pending: boolean;
  recoverable: boolean;
  error: string | null;
  /** Each complete local segment's save state, in take and segment order. */
  segments: SegmentSave[];
};

/**
 * Capture is settled once nothing more can be written: not recording and not
 * finalizing, or finalization latched a failure (it will not finish on its
 * own, so recovery and export must become available).
 */
export function keeperCaptureSettled(keeper: {
  recordingLocally: boolean;
  finalizing: boolean;
  error: string | null;
}): boolean {
  return (
    !keeper.recordingLocally && (!keeper.finalizing || keeper.error !== null)
  );
}

const RECOVERABLE_COPY =
  "A readable partial full-quality recording was kept on this device. Recover it before saving to the project.";
const INCOMPLETE_COPY =
  "An incomplete segment of your full-quality recording was kept on this device for recovery.";

/** Every retained-segment problem is reported, not only the first. */
function abandonedCopy(recoverable: boolean, lossReasons: string[]): string {
  const parts = recoverable ? [RECOVERABLE_COPY, ...lossReasons] : lossReasons;
  return parts.length > 0 ? parts.join(" ") : INCOMPLETE_COPY;
}

const EMPTY: RecordUploadProgress = {
  acked: 0,
  total: 0,
  fileAck: false,
  landed: false,
  landFailed: false,
  reclaimFailed: false,
  reclaimMismatch: false,
  uploading: false,
  pending: false,
  recoverable: false,
  error: null,
  segments: [],
};

type UploadArgs = {
  enabled: boolean;
  roomState?: string;
  captureSettled?: boolean;
  sessionId: string | null;
  takeIndex: number;
  participantId: string | null;
  transport: RecordUploadTransport | null;
  sink: ByteSink | null;
  captureExpected?: boolean;
  retryNonce?: number;
};

type RestartInputs = Pick<
  UploadArgs,
  "enabled" | "sessionId" | "participantId" | "transport" | "sink"
>;

type UploadObservation =
  | { kind: "inactive" }
  | { kind: "active" }
  | {
      kind: "chunk-progress";
      ackedBefore: number;
      totalBefore: number;
      chunks: { acked: number; total: number };
      live: SegmentSave;
      passSegments: readonly SegmentSave[];
    }
  | { kind: "pass-complete"; progress: RecordUploadProgress }
  | { kind: "pass-failed"; cause: unknown; holdsSegment: boolean };

async function holdsKeeperSegment(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  takeIndex: number,
): Promise<boolean> {
  try {
    const first = await keeperSegmentPaths(
      sink,
      sessionId,
      participantId,
      takeIndex,
    ).next();
    return !first.done;
  } catch {
    return true;
  }
}

class UploadPoller {
  private readonly observe: (event: UploadObservation) => void;

  constructor(observe: (event: UploadObservation) => void) {
    this.observe = observe;
  }

  acquire(
    inputs: RestartInputs,
    readCommitted: () => UploadArgs,
    reclaim: ReturnType<typeof createKeeperReclaimTracker>,
  ): (() => void) | undefined {
    if (
      !inputs.enabled ||
      !inputs.sessionId ||
      !inputs.participantId ||
      !inputs.transport ||
      !inputs.sink
    ) {
      this.observe({ kind: "inactive" });
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let stalledTicks = 0;
    let lastAcked = -1;
    let lastTotal = -1;
    let cleanupInFlight = false;
    let nextCleanupAt = 0;
    let refreshAfterCleanup = false;
    const abort = new AbortController();
    this.observe({ kind: "active" });
    const tick = async () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      const current = readCommitted();
      const { sessionId, participantId, transport, sink, takeIndex } = current;
      const stopped = current.roomState === "stopped";
      const settled = stopped && Boolean(current.captureSettled);
      if (!sessionId || !participantId || !transport || !sink) {
        inFlight = false;
        return;
      }
      try {
        if (settled && !cleanupInFlight && Date.now() >= nextCleanupAt) {
          cleanupInFlight = true;
          nextCleanupAt = Date.now() + 30_000;
          // Maintenance runs outside the host-status/upload critical path.
          void pruneExpiredKeeperWavs(sink, () => {
            if (cancelled) return false;
            const latest = readCommitted();
            return (
              latest.roomState === "stopped" && Boolean(latest.captureSettled)
            );
          })
            .then((cleanup) => {
              nextCleanupAt = cleanup.nextRunAt;
              if (cleanup.pruned > 0 && !cancelled) {
                refreshAfterCleanup = true;
                if (!inFlight) {
                  refreshAfterCleanup = false;
                  window.setTimeout(() => void tick(), 0);
                }
              }
            })
            .catch(() => {
              nextCleanupAt = Date.now() + 30_000;
            })
            .finally(() => {
              cleanupInFlight = false;
            });
        }
        const remote = await transport.status(abort.signal);
        let acked = 0;
        let total = 0;
        let allAcked = true;
        let allLanded = true;
        let landFailed = false;
        let saw = false;
        let awaitingAck = false;
        let finalizing = false;
        let abandoned = false;
        let expired = false;
        let recoverable = false;
        let reclaimMismatch = false;
        const segments: SegmentSave[] = [];
        const lossReasons = new Set<string>();
        for await (const {
          takeIndex: take,
          segmentIndex,
          wavPath,
        } of keeperSegmentPaths(sink, sessionId, participantId, takeIndex)) {
          saw = true;
          const remoteSeg = remote.segments.find(
            (row) =>
              row.take_index === take &&
              row.segment_index === segmentIndex &&
              row.participant_id === participantId,
          );
          // Local completion is required even when the host reports an ACK.
          // A pending WAV must still surface recovery instead of looking landed.
          const recovery = await inspectKeeperRecovery(sink, wavPath, {
            inspectPending: settled,
          });
          if (recovery.kind === "pruned") {
            expired = true;
            allAcked = false;
            allLanded = false;
            continue;
          }
          if (remoteSeg?.file_ack && recovery.kind === "complete") {
            const n = remoteSeg.expected_parts ?? remoteSeg.acked_parts.length;
            acked += n;
            total += n;
            segments.push({
              take,
              segment: segmentIndex,
              state: "saved",
              chunks: null,
              landFailed: Boolean(remoteSeg.land_failed),
            });
            allLanded = allLanded && Boolean(remoteSeg.landed);
            landFailed = landFailed || Boolean(remoteSeg.land_failed);
            if (
              canReclaimKeeperSegment({ remoteSeg, take, takeIndex, settled })
            ) {
              // A fresh status response is the authority for cleanup. The
              // completion metadata stays as the segment identity marker.
              if (
                (await reclaimKeeperWav(sink, wavPath, reclaim, remoteSeg)) ===
                "mismatch"
              ) {
                reclaimMismatch = true;
              }
            }
            continue;
          }
          // Pending segments are never uploaded, and their WAV is only probed
          // once capture has settled: during REC it may still be open.
          if (recovery.kind !== "complete") {
            allLanded = false;
            allAcked = false;
            if (!stopped) continue;
            if (!settled) {
              // Stop is still finalizing this segment; hold Leave until the
              // complete metadata lands (or capture latches a failure).
              finalizing = true;
              continue;
            }
            abandoned = true;
            if (recovery.kind === "recoverable") recoverable = true;
            if (recovery.kind === "unrecoverable") {
              lossReasons.add(recovery.reason);
            }
            continue;
          }
          const wav = await sink.read(wavPath);
          if (!wav) {
            // Complete metadata without its WAV is a landed, reclaimed segment
            // (see missingKeeperWavState); the host row may since have gone
            // (e.g. Discard take). Nothing left to upload or wait on.
            continue;
          }
          // A pre-fix disk can hold a finalized segment with no audio; it was
          // reported, so the server shows it stalled, but it must not block
          // the segments after it.
          if (wav.byteLength <= RECORD_UPLOAD_WAV_HEADER) continue;
          allLanded = false;
          const ackedBefore = acked;
          const totalBefore = total;
          const result = await uploadKeeperWav({
            wav,
            takeIndex: take,
            segmentIndex,
            transport,
            ackedParts: remoteSeg?.acked_parts ?? [],
            fileAck: false,
            joinOffsetMs: recovery.joinOffsetMs,
            clippingRegions: recovery.clippingRegions,
            clippingTruncated: recovery.clippingTruncated,
            signal: abort.signal,
            onProgress: (chunks) => {
              if (cancelled) return;
              // Publish mid-pass: the pass runs as long as every segment's
              // upload, and a person watching sees only what this publishes.
              const live: SegmentSave = {
                take,
                segment: segmentIndex,
                state: "saving",
                chunks,
                landFailed: false,
              };
              this.observe({
                kind: "chunk-progress",
                ackedBefore,
                totalBefore,
                chunks,
                live,
                passSegments: segments,
              });
            },
          });
          acked += result.acked;
          total += result.total;
          segments.push({
            take,
            segment: segmentIndex,
            state: result.fileAck ? "saved" : "saving",
            chunks: result.fileAck
              ? null
              : { acked: result.acked, total: result.total },
            landFailed: result.landFailed,
          });
          if (!result.fileAck) {
            allAcked = false;
            awaitingAck = true;
          }
          allLanded = allLanded && result.landed;
          landFailed = landFailed || result.landFailed;
        }
        if (!cancelled) {
          if (!stopped || acked !== lastAcked || total !== lastTotal) {
            stalledTicks = 0;
          } else if (awaitingAck) {
            stalledTicks += 1;
          } else {
            stalledTicks = 0;
          }
          lastAcked = acked;
          lastTotal = total;
          const stalled = stalledTicks >= 3;
          const abandonedError =
            abandoned && !awaitingAck
              ? abandonedCopy(recoverable, [...lossReasons])
              : null;
          const expiredError = expired
            ? "A segment of your full-quality recording without recovery information expired after seven days; that audio is no longer available here."
            : null;
          const recoveryError = [abandonedError, expiredError]
            .filter(Boolean)
            .join(" ");
          this.observe({
            kind: "pass-complete",
            progress: {
              acked,
              total,
              fileAck: saw && allAcked,
              landed: saw && allAcked && allLanded && !landFailed,
              landFailed,
              reclaimFailed: keeperReclaimStuck(reclaim),
              reclaimMismatch,
              uploading: (awaitingAck && !stalled) || finalizing,
              pending: false,
              recoverable,
              segments,
              error:
                (recoveryError || null) ??
                (!saw && stopped && current.captureExpected !== false
                  ? "No full-quality recording was captured. Check this device's copy before leaving."
                  : stalled
                    ? UPLOAD_STALLED_COPY
                    : null),
            },
          });
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) {
          return;
        }
        this.observe({
          kind: "pass-failed",
          cause: err,
          holdsSegment: await holdsKeeperSegment(
            sink,
            sessionId,
            participantId,
            takeIndex,
          ),
        });
      } finally {
        inFlight = false;
        if (refreshAfterCleanup && !cancelled) {
          refreshAfterCleanup = false;
          window.setTimeout(() => void tick(), 0);
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }
}

export function useRecordUpload(args: UploadArgs): RecordUploadProgress {
  const [progress, setProgress] = useState<RecordUploadProgress>(EMPTY);
  const argsRef = useRef(args);
  const reclaim = useRef(createKeeperReclaimTracker());
  const [poller] = useState(
    () =>
      new UploadPoller((event) => {
        switch (event.kind) {
          case "inactive":
            setProgress(EMPTY);
            break;
          case "active":
            setProgress((prev) => ({ ...prev, pending: true, error: null }));
            break;
          case "chunk-progress":
            setProgress((prev) => ({
              ...prev,
              acked: event.ackedBefore + event.chunks.acked,
              total: event.totalBefore + event.chunks.total,
              fileAck: false,
              landed: false,
              uploading: true,
              pending: false,
              segments: mergeSegmentSaves(prev.segments, [
                ...event.passSegments,
                event.live,
              ]),
            }));
            break;
          case "pass-complete":
            setProgress(event.progress);
            break;
          case "pass-failed":
            setProgress((prev) => ({
              ...prev,
              uploading: false,
              pending: false,
              error: event.holdsSegment ? errorMessage(event.cause) : null,
            }));
            break;
        }
      }),
  );
  useInsertionEffect(() => {
    argsRef.current = args;
  }, [args]);

  useEffect(
    () =>
      poller.acquire(
        {
          enabled: args.enabled,
          sessionId: args.sessionId,
          participantId: args.participantId,
          transport: args.transport,
          sink: args.sink,
        },
        () => argsRef.current,
        reclaim.current,
      ),
    [
      poller,
      args.enabled,
      args.roomState,
      args.captureSettled,
      args.sessionId,
      args.takeIndex,
      args.participantId,
      args.transport,
      args.sink,
      args.retryNonce,
    ],
  );

  return progress;
}

export function useHostUploadSegments(
  transport: RecordUploadTransport | null,
  enabled: boolean,
): RecordUploadStatus["segments"] {
  const [view, setView] = useState<{
    owner: { enabled: boolean; transport: RecordUploadTransport | null };
    segments: RecordUploadStatus["segments"];
  }>(() => ({ owner: { enabled, transport }, segments: [] }));
  if (view.owner.enabled !== enabled || view.owner.transport !== transport) {
    setView({
      owner: { enabled, transport },
      segments: enabled && transport ? view.segments : [],
    });
  }
  const owner = view.owner;
  useEffect(() => {
    if (!enabled || !transport) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const remote = await transport.status();
        if (!cancelled) {
          setView((current) =>
            current.owner === owner
              ? { owner, segments: remote.segments }
              : current,
          );
        }
      } catch {
        // A failed poll keeps the last good snapshot; the next tick retries.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, transport, owner]);
  return view.segments;
}
