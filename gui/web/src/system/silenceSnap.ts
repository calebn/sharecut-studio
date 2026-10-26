/** The suggestion waveform shows 6 s either side of the change. */
export const WAVEFORM_WINDOW_S = 12;
export const SILENCE_THRESHOLD = 0.12;
export const SNAP_RADIUS_S = 0.3;
export const MIN_RANGE_S = 0.1;

export type SnapOptions = {
  /** Seconds covered by the peaks. */
  windowSeconds: number;
  /** Peaks at or under this are silence, 0 to 1. */
  threshold?: number;
  /** How far from the pointer a quiet sample may be, in seconds. */
  radius?: number;
};

/**
 * Moves a time (seconds from the window start) to the nearest quiet peak
 * within the radius. Without a quiet peak in reach the time stays where it is.
 */
export function snapToSilence(
  time: number,
  peaks: readonly number[],
  {
    windowSeconds,
    threshold = SILENCE_THRESHOLD,
    radius = SNAP_RADIUS_S,
  }: SnapOptions,
): number {
  if (peaks.length === 0 || windowSeconds <= 0) return time;
  const step = windowSeconds / peaks.length;
  const first = Math.max(0, Math.floor((time - radius) / step));
  const last = Math.min(peaks.length - 1, Math.ceil((time + radius) / step));
  let best: number | null = null;
  for (let index = first; index <= last; index += 1) {
    if ((peaks[index] ?? 1) > threshold) continue;
    const centre = (index + 0.5) * step;
    if (Math.abs(centre - time) > radius) continue;
    if (best === null || Math.abs(centre - time) < Math.abs(best - time)) {
      best = centre;
    }
  }
  return best ?? time;
}

export type SuggestionRange = { start: number; end: number };

/** Keeps a range inside the window with at least `MIN_RANGE_S` between its edges. */
export function clampRange(
  range: SuggestionRange,
  edge: "start" | "end",
  window: SuggestionRange,
): SuggestionRange {
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
