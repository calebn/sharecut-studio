import { clamp } from "../utils/math";
import type { TimeRange } from "./seconds";

export type Bounds = readonly [min: number, max: number];

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
  if (grip === "move") return [0, Math.max(0, duration - (to - from))];
  return edgeBounds(grip, { start: from, end: to }, duration, minSpan);
}

export function within([min, max]: Bounds, value: number): number {
  return clamp(value, min, max);
}

/** A move from `from` that stays inside the bounds; one already inside is returned as it came. */
export function boundedDelta(
  [min, max]: Bounds,
  from: number,
  delta: number,
): number {
  return clamp(delta, min - from, max - from);
}
