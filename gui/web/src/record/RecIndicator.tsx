import { useEffect, useState } from "react";
import { recordingClockMs } from "./clock";
import type { RecordSnapshot } from "./types";

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RecIndicator({
  snapshot,
  captureFailed = false,
  capturePending = false,
}: {
  snapshot: RecordSnapshot;
  captureFailed?: boolean;
  capturePending?: boolean;
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
    label = captureFailed
      ? "REC — local capture failed"
      : capturePending
        ? "REC — waiting for microphone"
        : "REC";
  } else if (snapshot.state === "paused") {
    label = "PAUSED";
  } else if (snapshot.state === "stopped") {
    label = "Stopped";
  }
  const clock = recordingClockMs(
    { ...snapshot, recording_ms: baseMs },
    now - markedAt,
  );
  return (
    <div className="cluster record-indicator" role="status">
      <span className="record-rec-label" data-state={snapshot.state}>
        {label}
      </span>
      <span className="record-clock" aria-live="off">
        {formatClock(clock)}
      </span>
    </div>
  );
}
