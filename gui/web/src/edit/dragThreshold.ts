/**
 * Click-versus-drag decisions for edit handles. The thresholds themselves live
 * with every other gesture threshold in `hooks/gestureConstants.ts`.
 */
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";

/** A roll whose clamped delta is under this is a no-op (the clamp can shrink a real drag). */
export const ROLL_COMMIT_MIN_PX = 0.5;

/**
 * True when a handle moved far enough between pointerdown and pointerup to be
 * an edit. Only the net displacement counts: a drag that comes back to within
 * HANDLE_DRAG_MIN_PX of where it started is a click. It saves nothing and its
 * preview snaps back.
 */
export function isHandleDrag(originX: number, clientX: number): boolean {
  return Math.abs(clientX - originX) >= HANDLE_DRAG_MIN_PX;
}
