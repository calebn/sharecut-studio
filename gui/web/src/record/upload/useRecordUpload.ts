import { useEffect, useRef, useState } from "react";
import { type ByteSink, keeperSegmentPaths } from "../keeper/store";
import { uploadKeeperWav } from "./pump";
import { inspectKeeperRecovery } from "./recovery";
import type { RecordUploadStatus, RecordUploadTransport } from "./transport";

export type RecordUploadProgress = {
  acked: number;
  total: number;
  fileAck: boolean;
  landed: boolean;
  landFailed: boolean;
  uploading: boolean;
  pending: boolean;
  recoverable: boolean;
  error: string | null;
};

export function leaveBlocked(
  state: string,
  upload?: RecordUploadProgress | null,
): boolean {
  if (state !== "stopped" || !upload || upload.error) {
    return false;
  }
  if (upload.fileAck) {
    return false;
  }
  return upload.pending || upload.uploading || upload.total > 0;
}

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
  "A readable partial keeper was retained. Recover it before uploading.";
const INCOMPLETE_COPY =
  "An incomplete local keeper segment was retained for recovery.";
const MISSING_FINALIZED_COPY =
  "The finalized local keeper is missing and was not acknowledged by the host. Download any other retained segments and ask the host to check the take.";

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
  uploading: false,
  pending: false,
  recoverable: false,
  error: null,
};

export function useRecordUpload(args: {
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
}): RecordUploadProgress {
  const [progress, setProgress] = useState<RecordUploadProgress>(EMPTY);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (
      !args.enabled ||
      !args.sessionId ||
      !args.participantId ||
      !args.transport ||
      !args.sink
    ) {
      setProgress(EMPTY);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let stalledTicks = 0;
    let lastAcked = -1;
    let lastTotal = -1;
    const abort = new AbortController();
    setProgress((prev) => ({ ...prev, pending: true, error: null }));
    const tick = async () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      const current = argsRef.current;
      const { sessionId, participantId, transport, sink, takeIndex } = current;
      if (!sessionId || !participantId || !transport || !sink) {
        inFlight = false;
        return;
      }
      try {
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
        let recoverable = false;
        const lossReasons = new Set<string>();
        const stopped = current.roomState === "stopped";
        const settled = stopped && current.captureSettled === true;
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
          if (remoteSeg?.file_ack) {
            const n = remoteSeg.expected_parts ?? remoteSeg.acked_parts.length;
            acked += n;
            total += n;
            allLanded = allLanded && Boolean(remoteSeg.landed);
            landFailed = landFailed || Boolean(remoteSeg.land_failed);
            continue;
          }
          allLanded = false;
          // Pending segments are never uploaded, and their WAV is only probed
          // once capture has settled: during REC it may still be open.
          const recovery = await inspectKeeperRecovery(sink, wavPath, {
            inspectPending: settled,
          });
          if (recovery.kind !== "complete") {
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
            allAcked = false;
            if (settled) {
              abandoned = true;
              lossReasons.add(MISSING_FINALIZED_COPY);
            } else {
              awaitingAck = true;
            }
            continue;
          }
          const result = await uploadKeeperWav({
            wav,
            takeIndex: take,
            segmentIndex,
            transport,
            ackedParts: remoteSeg?.acked_parts ?? [],
            fileAck: false,
            joinOffsetMs: recovery.joinOffsetMs,
            signal: abort.signal,
          });
          acked += result.acked;
          total += result.total;
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
          setProgress({
            acked,
            total,
            fileAck: saw && allAcked,
            landed: saw && allAcked && allLanded && !landFailed,
            landFailed,
            uploading: (awaitingAck && !stalled) || finalizing,
            pending: false,
            recoverable,
            error:
              abandonedError ??
              (!saw && stopped && current.captureExpected !== false
                ? "No local keeper was captured. Check the local copy before leaving."
                : stalled
                  ? "Upload stalled. Resume the upload or download the local keeper copy."
                  : null),
          });
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) {
          return;
        }
        if (!cancelled) {
          setProgress((prev) => ({
            ...prev,
            uploading: false,
            pending: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [
    args.enabled,
    args.roomState,
    args.captureSettled,
    args.sessionId,
    args.takeIndex,
    args.participantId,
    args.transport,
    args.sink,
    args.retryNonce,
  ]);

  return progress;
}

export function useHostUploadSegments(
  transport: RecordUploadTransport | null,
  enabled: boolean,
): RecordUploadStatus["segments"] {
  const [segments, setSegments] = useState<RecordUploadStatus["segments"]>([]);
  useEffect(() => {
    if (!enabled || !transport) {
      setSegments([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const remote = await transport.status();
        if (!cancelled) {
          setSegments(remote.segments);
        }
      } catch {
        /* keep last successful snapshot */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, transport]);
  return segments;
}
