import { useEffect, useState } from "react";
import { recordingClockMs } from "./clock";
import {
  type CaptureHealth,
  REC_CAPTURE_LABEL,
  REC_OFFLINE_SUFFIX,
  type RecordSnapshot,
} from "./types";

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RecIndicator({
  snapshot,
  capture = null,
  clockId,
  offline = false,
}: {
  snapshot: RecordSnapshot;
  capture?: CaptureHealth;
  clockId?: string;
  /** Host record socket is down; only affects recording and paused. */
  offline?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [markedAt, setMarkedAt] = useState(() => Date.now());
  const [baseMs, setBaseMs] = useState(snapshot.recording_ms ?? 0);

  useEffect(() => {
    setBaseMs(snapshot.recording_ms ?? 0);
    setMarkedAt(Date.now());
  }, [snapshot.recording_ms, snapshot.state]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  let label = "Waiting for host";
  if (snapshot.state === "recording") {
    label = capture ? REC_CAPTURE_LABEL[capture] : "REC";
  } else if (snapshot.state === "paused") {
    label = "PAUSED";
  } else if (snapshot.state === "stopped") {
    label = "Stopped";
  }
  const showOffline =
    offline &&
    !capture &&
    (snapshot.state === "recording" || snapshot.state === "paused");
  if (showOffline) {
    label = `${label} ${REC_OFFLINE_SUFFIX}`;
  }
  const clock = recordingClockMs(
    { ...snapshot, recording_ms: baseMs },
    now - markedAt,
  );
  return (
    <div className="cluster record-indicator" role="status">
      <span className="record-rec-label" data-state={snapshot.state}>
        {snapshot.state === "recording" && !capture && !showOffline ? (
          <span className="record-rec-dot" aria-hidden="true" />
        ) : null}
        {label}
      </span>
      <span id={clockId} className="record-clock" aria-live="off">
        {formatClock(clock)}
      </span>
    </div>
  );
}
