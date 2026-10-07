/**
 * Where a swiped drawer settles (#1051): the compact inspector swipes between
 * its detents (peek, half, full). A release coasts on the finger's momentum
 * the way a flicked scroll view does (Apple, "Designing Fluid Interfaces",
 * WWDC 2018): decelerating by `DRAWER_DECELERATION` every ms, it would travel
 * velocity × d / (1 − d) further, and the sheet settles at the detent nearest
 * that projected height. A quick flick so opens or closes fully, and a slow
 * drag lands where it was left.
 */
import {
  DRAWER_DECELERATION,
  DRAWER_STOP_MS,
  DRAWER_VELOCITY_WINDOW_MS,
} from "../hooks/gestureConstants";

/** A finger position: px down the screen, at `t` ms. */
export interface DragSample {
  y: number;
  t: number;
}

/**
 * The finger's speed as it lifts at `releaseAt` ms, px/ms (positive is down):
 * over its moves in the `DRAWER_VELOCITY_WINDOW_MS` before its last one, or
 * none if it had rested `DRAWER_STOP_MS` before lifting.
 */
export function releaseVelocity(
  samples: readonly DragSample[],
  releaseAt: number,
): number {
  let end = samples.length - 1;
  while (end > 0 && samples[end].y === samples[end - 1].y) end -= 1;
  const last = samples[end];
  if (!last || end === 0 || releaseAt - last.t > DRAWER_STOP_MS) return 0;
  const first = samples.find((s) => last.t - s.t <= DRAWER_VELOCITY_WINDOW_MS);
  if (!first || last.t === first.t) return 0;
  return (last.y - first.y) / (last.t - first.t);
}

/** The sheet's height once a release at `heightPx` and `velocity` coasts to rest. */
export function projectedHeight(heightPx: number, velocity: number): number {
  return (
    heightPx - (velocity * DRAWER_DECELERATION) / (1 - DRAWER_DECELERATION)
  );
}

/** The detent, of `[detent, height px]` pairs, nearest the projected height. */
export function settleDetent<T>(
  heights: readonly (readonly [T, number])[],
  heightPx: number,
  velocity: number,
): T {
  const target = projectedHeight(heightPx, velocity);
  let best = heights[0];
  for (const entry of heights) {
    if (Math.abs(entry[1] - target) < Math.abs(best[1] - target)) best = entry;
  }
  return best[0];
}
