import { useLayoutEffect, useRef } from "react";
import { useRecordHostStore } from "../record/hostStore";
import { hasRecordingFrame, recordingFrame } from "./recordingFrame";

export function RecordingOverlay({
  zoomPxPerSec,
  trailingPadPx,
}: {
  zoomPxPerSec: number;
  trailingPadPx: number;
}) {
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const receivedAtMs = useRecordHostStore((s) => s.receivedAtMs);
  const extent = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  const needle = useRef<HTMLDivElement>(null);
  const active = hasRecordingFrame(snapshot, receivedAtMs);
  useLayoutEffect(() => {
    if (!active) return;
    let disposed = false;
    let id = 0;
    const paint = (now: number) => {
      if (disposed) return;
      const frame = recordingFrame(snapshot, receivedAtMs, now);
      if (!frame || !extent.current || !band.current || !needle.current) return;
      const endPx = frame.endSec * zoomPxPerSec;
      extent.current.style.width = `${endPx + trailingPadPx}px`;
      band.current.style.left = `${frame.startSec * zoomPxPerSec}px`;
      band.current.style.width = `${(frame.endSec - frame.startSec) * zoomPxPerSec}px`;
      needle.current.style.left = `${endPx}px`;
      if (snapshot?.state === "recording") id = requestAnimationFrame(paint);
    };
    paint(performance.now());
    return () => {
      disposed = true;
      cancelAnimationFrame(id);
    };
  }, [active, snapshot, receivedAtMs, zoomPxPerSec, trailingPadPx]);
  if (!active || !snapshot) return null;
  return (
    <div
      ref={extent}
      className="recording-overlay"
      data-state={snapshot.state}
      role="img"
      aria-label={`Take ${snapshot.take_index + 1} ${snapshot.state} — provisional recording`}
    >
      <div ref={band} className="recording-overlay-band">
        <span>
          Take {snapshot.take_index + 1} ·{" "}
          {snapshot.state === "paused" ? "PAUSED" : "Recording"}
        </span>
      </div>
      <div ref={needle} className="recording-overlay-needle" />
    </div>
  );
}

export function RecordingScrollExtent({
  zoomPxPerSec,
  timelineWidthPx,
}: {
  zoomPxPerSec: number;
  timelineWidthPx: number;
}) {
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const receivedAtMs = useRecordHostStore((s) => s.receivedAtMs);
  const extent = useRef<HTMLDivElement>(null);
  const active = hasRecordingFrame(snapshot, receivedAtMs);
  useLayoutEffect(() => {
    if (!active) return;
    let disposed = false;
    let id = 0;
    const paint = (now: number) => {
      if (disposed || !extent.current) return;
      const frame = recordingFrame(snapshot, receivedAtMs, now);
      if (!frame) return;
      extent.current.style.width = `${Math.max(0, frame.endSec * zoomPxPerSec - timelineWidthPx)}px`;
      if (snapshot?.state === "recording") id = requestAnimationFrame(paint);
    };
    paint(performance.now());
    return () => {
      disposed = true;
      cancelAnimationFrame(id);
    };
  }, [active, snapshot, receivedAtMs, zoomPxPerSec, timelineWidthPx]);
  if (!active) return null;
  return (
    <div ref={extent} className="recording-scroll-extent" aria-hidden="true" />
  );
}
