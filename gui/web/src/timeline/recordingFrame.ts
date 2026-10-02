import { recordingClockMs } from "../record/clock";
import type { RecordSnapshot } from "../record/types";

type TimedRecordSnapshot = RecordSnapshot & {
  timeline_start_sec: number;
  recording_ms: number;
};

export function hasRecordingFrame(
  snapshot: RecordSnapshot | null,
  receivedAtMs: number | null,
): snapshot is TimedRecordSnapshot {
  const startSec = snapshot?.timeline_start_sec;
  return (
    snapshot !== null &&
    ["recording", "paused"].includes(snapshot.state) &&
    typeof startSec === "number" &&
    Number.isFinite(startSec) &&
    startSec >= 0 &&
    receivedAtMs !== null &&
    Number.isFinite(receivedAtMs) &&
    typeof snapshot.recording_ms === "number" &&
    Number.isFinite(snapshot.recording_ms) &&
    snapshot.recording_ms >= 0
  );
}

export function recordingFrame(
  snapshot: RecordSnapshot | null,
  receivedAtMs: number | null,
  nowMs: number,
) {
  if (
    !hasRecordingFrame(snapshot, receivedAtMs) ||
    receivedAtMs === null ||
    !Number.isFinite(nowMs)
  ) {
    return null;
  }
  const startSec = snapshot.timeline_start_sec;
  return {
    startSec,
    endSec: startSec + recordingClockMs(snapshot, nowMs - receivedAtMs) / 1000,
  };
}
