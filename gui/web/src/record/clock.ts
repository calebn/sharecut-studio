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

/** m:ss for a millisecond duration. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
