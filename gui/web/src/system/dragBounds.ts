import { clamp } from "../utils/math";
import type { TimeRange } from "./seconds";

export type Bounds = readonly [min: number, max: number];

/** No limit: a span longer than the episode, or an episode whose length is not known yet (0), is not pinned. */
export const UNBOUNDED: Bounds = [
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
];

/** The range a selection edge may take: the episode, and never past the other edge. */
export function edgeBounds(
  edge: "start" | "end",
  selection: TimeRange,
  duration: number,
  minSpan: number,
): Bounds {
  return edge === "start"
    ? [0, Math.max(0, selection.end - minSpan)]
    : [Math.min(duration, selection.start + minSpan), duration];
}

/** The range a marker's start (`move` carries its length along) or a clip's end may take. */
export function spanBounds(
  grip: "move" | "start" | "end",
  from: number,
  to: number,
  duration: number,
  minSpan: number,
): Bounds {
  if (!(duration > 0)) return UNBOUNDED;
  if (grip === "move") {
    return to - from >= duration ? UNBOUNDED : [0, duration - (to - from)];
  }
  if (grip === "end" && from + minSpan > duration) return UNBOUNDED;
  return edgeBounds(grip, { start: from, end: to }, duration, minSpan);
}

export function within([min, max]: Bounds, value: number): number {
  return clamp(value, min, max);
}

/** A move from `from` that stays inside the bounds; one already inside is returned as it came, and a non-finite one is no move. */
export function boundedDelta(
  [min, max]: Bounds,
  from: number,
  delta: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  return clamp(delta, min - from, max - from);
}
