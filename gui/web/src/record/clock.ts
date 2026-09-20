import type { RecordSnapshot } from "./types";

export function recordingClockMs(
  snap: RecordSnapshot,
  elapsedSinceSnapMs = 0,
): number {
  const base = snap.recording_ms ?? 0;
  if (snap.state !== "recording") {
    return base;
  }
  return base + Math.max(0, elapsedSinceSnapMs);
}
