import { useEffect, useRef, useState } from "react";
import {
  canReclaimKeeperSegment,
  createKeeperReclaimTracker,
  keeperReclaimStuck,
  reclaimKeeperWav,
} from "../keeper/reclaim";
import {
  type ByteSink,
  keeperMetaComplete,
  keeperMetaPath,
  keeperWavPath,
  missingKeeperWavState,
} from "../keeper/store";
import { UPLOAD_STALLED_COPY } from "../types";
import { uploadKeeperWav } from "./pump";
import type { RecordUploadStatus, RecordUploadTransport } from "./transport";

export type RecordUploadProgress = {
  acked: number;
  total: number;
  fileAck: boolean;
  landed: boolean;
  landFailed: boolean;
  /** Landed keeper WAVs could not be deleted after repeated attempts. */
  reclaimFailed: boolean;
  uploading: boolean;
  pending: boolean;
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

const EMPTY: RecordUploadProgress = {
  acked: 0,
  total: 0,
  fileAck: false,
  landed: false,
  landFailed: false,
  reclaimFailed: false,
  uploading: false,
  pending: false,
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
  const reclaim = useRef(createKeeperReclaimTracker());
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
      const stopped = current.roomState === "stopped";
      const settled = stopped && Boolean(current.captureSettled);
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
        let abandoned = false;
        for (let take = 0; take <= takeIndex; take += 1) {
          const next = await sink.nextSegmentIndex(
            sessionId,
            take,
            participantId,
          );
          for (let segmentIndex = 0; segmentIndex < next; segmentIndex += 1) {
            saw = true;
            const remoteSeg = remote.segments.find(
              (row) =>
                row.take_index === take &&
                row.segment_index === segmentIndex &&
                row.participant_id === participantId,
            );
            const wavPath = keeperWavPath({
              sessionId,
              takeIndex: take,
              participantId,
              segmentIndex,
            });
            if (remoteSeg?.file_ack) {
              const n =
                remoteSeg.expected_parts ?? remoteSeg.acked_parts.length;
              acked += n;
              total += n;
              allLanded = allLanded && Boolean(remoteSeg.landed);
              landFailed = landFailed || Boolean(remoteSeg.land_failed);
              if (
                canReclaimKeeperSegment({ remoteSeg, take, takeIndex, settled })
              ) {
                // A fresh status response is the authority for cleanup. The
                // completion metadata stays as the segment identity marker.
                await reclaimKeeperWav(sink, wavPath, reclaim.current);
              }
              continue;
            }
            const wav = await sink.read(wavPath);
            if (!wav) {
              if (
                reclaim.current.reclaimed.has(wavPath) ||
                (await missingKeeperWavState(sink, wavPath)) === "reclaimed"
              ) {
                // Landed and reclaimed earlier; the host row may since have
                // gone (e.g. Discard take). Nothing left to upload or wait on.
                continue;
              }
              allLanded = false;
              allAcked = false;
              awaitingAck = true;
              continue;
            }
            allLanded = false;
            const metaBytes = await sink.read(keeperMetaPath(wavPath));
            const complete = keeperMetaComplete(metaBytes);
            if (!complete && settled) {
              // A stopped capture cannot finish this segment. Keep its local
              // bytes for recovery, but do not repeatedly upload a partial WAV
              // or hold Leave after all complete segments have an ACK.
              abandoned = true;
              allAcked = false;
              allLanded = false;
              continue;
            }
            let joinOffsetMs = 0;
            if (metaBytes) {
              try {
                const meta = JSON.parse(
                  new TextDecoder().decode(metaBytes),
                ) as {
                  joinOffsetMs?: number;
                };
                joinOffsetMs = Number(meta.joinOffsetMs) || 0;
              } catch {
                joinOffsetMs = 0;
              }
            }
            const result = await uploadKeeperWav({
              wav,
              complete,
              takeIndex: take,
              segmentIndex,
              transport,
              ackedParts: remoteSeg?.acked_parts ?? [],
              fileAck: Boolean(remoteSeg?.file_ack),
              joinOffsetMs,
              signal: abort.signal,
            });
            acked += result.acked;
            total += result.total;
            if (!complete || !result.fileAck) {
              allAcked = false;
              awaitingAck = true;
            }
            allLanded = allLanded && result.landed;
            landFailed = landFailed || result.landFailed;
          }
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
              ? "An incomplete local keeper segment was retained for recovery."
              : null;
          setProgress({
            acked,
            total,
            fileAck: saw && allAcked,
            landed: saw && allAcked && allLanded && !landFailed,
            landFailed,
            reclaimFailed: keeperReclaimStuck(reclaim.current),
            uploading: awaitingAck && !stalled,
            pending: false,
            error:
              abandonedError ??
              (!saw && stopped && current.captureExpected !== false
                ? "No local keeper was captured. Check the local copy before leaving."
                : stalled
                  ? UPLOAD_STALLED_COPY
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
