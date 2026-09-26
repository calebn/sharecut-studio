/**
 * Pointer thresholds that tell a click from a drag, in CSS px at the current
 * zoom, so edits behave the same at any zoom (docs/waveform.md § Precision).
 *
 * Handles (fade, trim, roll, pending-cut edges, social-clip markers) are thin,
 * one-axis targets: 3 px of net horizontal movement is a drag. A clip body is a
 * wide, two-axis target that can also change lanes, so a press must travel
 * 5 px (any direction) before a move starts. That absorbs press jitter.
 */

/** A handle drag shorter than this (net, pointerdown to pointerup) is a click: select, never commit. */
export const HANDLE_DRAG_MIN_PX = 3;

/** A clip-body press must travel this far (any direction) before it becomes a move. */
export const MOVE_THRESHOLD_PX = 5;

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
