import { useEffect, useRef, useState } from "react";
import { type ByteSink, keeperMetaPath, keeperWavPath } from "../keeper/store";
import { uploadKeeperWav } from "./pump";
import type { RecordUploadStatus, RecordUploadTransport } from "./transport";

export type RecordUploadProgress = {
  acked: number;
  total: number;
  fileAck: boolean;
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
  uploading: false,
  pending: false,
  error: null,
};

export function useRecordUpload(args: {
  enabled: boolean;
  sessionId: string | null;
  takeIndex: number;
  participantId: string | null;
  transport: RecordUploadTransport | null;
  sink: ByteSink | null;
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
        let saw = false;
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
            if (remoteSeg?.file_ack) {
              const n = remoteSeg.acked_parts.length;
              acked += n;
              total += n;
              continue;
            }
            const wavPath = keeperWavPath({
              sessionId,
              takeIndex: take,
              participantId,
              segmentIndex,
            });
            const wav = await sink.read(wavPath);
            if (!wav) {
              allAcked = false;
              continue;
            }
            const metaBytes = await sink.read(keeperMetaPath(wavPath));
            const complete = metaBytes != null;
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
            }
          }
        }
        if (!saw) {
          allAcked = true;
        }
        if (!cancelled) {
          setProgress({
            acked,
            total,
            fileAck: allAcked,
            uploading: saw && !allAcked,
            pending: false,
            error: null,
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
    args.sessionId,
    args.takeIndex,
    args.participantId,
    args.transport,
    args.sink,
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
