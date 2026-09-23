/**
 * Shared touch-gesture thresholds. Every recognizer (long-press, swipe,
 * transcript double-tap) reads these so tuning one value keeps them in step.
 */

/** Hold duration before a touch press counts as a long-press. */
export const LONG_PRESS_MS = 550;

/** Finger travel (px) that aborts a long-press. */
export const LONG_PRESS_MOVE_CANCEL_PX = 12;

/**
 * Window after a touch gesture in which the browser's synthesized click is
 * ignored (also the fallback delay for browsers that omit that click).
 */
export const GHOST_CLICK_MS = 500;

/** Max gap between two taps on the same word to count as a double-tap. */
export const DOUBLE_TAP_MS = 350;

/** Min leftward travel (px) for swipe-to-resolve. */
export const SWIPE_MIN_DX_PX = 48;

/** Vertical travel (px) that turns a swipe into a scroll. */
export const SWIPE_MAX_DY_PX = 24;

/** True while `at` (a `Date.now()` stamp) is inside the ghost-click window. */
export function withinGhostClick(at: number, now = Date.now()): boolean {
  return now - at < GHOST_CLICK_MS;
}
