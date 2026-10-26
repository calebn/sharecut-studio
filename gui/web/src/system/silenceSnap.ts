import type { TimeRange } from "./seconds";

/** The suggestion waveform shows 6 s either side of the change. */
export const WAVEFORM_WINDOW_S = 12;
const SILENCE_THRESHOLD = 0.12;
const SNAP_RADIUS_S = 0.3;
const MIN_RANGE_S = 0.1;

/**
 * Time is in seconds from the window start; peaks cover `windowSeconds`.
 * Without a quiet peak in reach the time stays put.
 */
export function snapToSilence(
  time: number,
  peaks: readonly number[],
  windowSeconds: number,
): number {
  if (peaks.length === 0 || windowSeconds <= 0) return time;
  const step = windowSeconds / peaks.length;
  const first = Math.max(0, Math.floor((time - SNAP_RADIUS_S) / step));
  const last = Math.min(
    peaks.length - 1,
    Math.ceil((time + SNAP_RADIUS_S) / step),
  );
  let best: number | null = null;
  for (let index = first; index <= last; index += 1) {
    if ((peaks[index] ?? 1) > SILENCE_THRESHOLD) continue;
    const centre = (index + 0.5) * step;
    if (Math.abs(centre - time) > SNAP_RADIUS_S) continue;
    if (best === null || Math.abs(centre - time) < Math.abs(best - time)) {
      best = centre;
    }
  }
  return best ?? time;
}

export function clampRange(
  range: TimeRange,
  edge: "start" | "end",
  window: TimeRange,
): TimeRange {
  if (edge === "start") {
    return {
      start: Math.min(
        Math.max(range.start, window.start),
        range.end - MIN_RANGE_S,
      ),
      end: range.end,
    };
  }
  return {
    start: range.start,
    end: Math.max(Math.min(range.end, window.end), range.start + MIN_RANGE_S),
  };
}
