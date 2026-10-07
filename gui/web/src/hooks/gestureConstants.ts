/**
 * Shared gesture thresholds. Every recognizer (timeline hit routing and target
 * chooser, clip and handle drags, long-press, swipe, transcript double-tap)
 * reads these, so tuning one value keeps them in step.
 *
 * The hold and slop values follow the platforms' own long-press conventions.
 * A CSS px on a phone is a device-independent pixel, the same unit as an iOS
 * point and an Android dp.
 * - iOS `UILongPressGestureRecognizer`: `minimumPressDuration` "The default
 *   duration is 0.5 seconds"; `allowableMovement` "The default distance is 10
 *   points".
 *   https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/minimumpressduration
 *   https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/allowablemovement
 * - Android `ViewConfiguration`: `TOUCH_SLOP` is 8 dp, the "distance a touch
 *   can wander before we think the user is scrolling"; `DEFAULT_LONG_PRESS_TIMEOUT`
 *   is 400 ms (500 ms before Android 12).
 *   https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/ViewConfiguration.java
 *   https://developer.android.com/develop/ui/views/touch-and-input/gestures/viewgroup
 */

/**
 * Hold duration before a touch press counts as a long-press: iOS's 0.5 s,
 * inside Android's 400-500 ms. The target chooser opens after this hold, and
 * resting on a chip this long grabs its target, so one rhythm serves both.
 */
export const LONG_PRESS_MS = 500;

/**
 * How far a held finger may drift and still count as still (px). iOS allows
 * 10 pt; Android starts a scroll after 8 dp. The browser applies its own
 * scroll slop, so this only judges a still finger, and the looser value keeps
 * natural drift from killing a hold.
 */
export const TOUCH_SLOP_PX = 10;

/**
 * Pointer thresholds that tell a click from a drag, in CSS px at the current
 * zoom, so edits behave the same at any zoom (docs/waveform.md § Precision).
 * Handles (fade, trim, roll, pending-cut edges, social-clip markers) are thin,
 * one-axis targets: 3 px of net horizontal movement is a drag. A clip body is
 * a wide, two-axis target that can also change lanes, so a press must travel
 * 5 px (any direction) before a move starts. That absorbs press jitter.
 */
export const HANDLE_DRAG_MIN_PX = 3;

/**
 * How long a finger that slid onto a chooser chip must stay within
 * `TOUCH_SLOP_PX` before a slide along the target's axis drags it. A finger
 * passing over chips on the way to another never settles, so it never grabs.
 * Android's `TAP_TIMEOUT` (100 ms), the wait "to see if a touch event is a tap
 * or a scroll", in the `ViewConfiguration` source cited above.
 */
export const CHIP_SETTLE_MS = 100;

/**
 * Hold-to-repeat for nudge buttons. A held button steps again after the
 * long-press hold, Android's `getKeyRepeatTimeout()` (its long-press timeout),
 * then every 100 ms, and after `NUDGE_ACCELERATE_AFTER` repeats every 50 ms,
 * Android's `getKeyRepeatDelay()`, in the `ViewConfiguration` source cited
 * above. Keyboard users get their system's own key repeat instead.
 */
export const NUDGE_REPEAT_MS = 100;
export const NUDGE_REPEAT_FAST_MS = 50;
export const NUDGE_ACCELERATE_AFTER = 4;

/** Wait before the next step of a held nudge, after `repeats` repeats so far. */
export function nudgeRepeatDelayMs(repeats: number): number {
  if (repeats === 0) return LONG_PRESS_MS;
  return repeats < NUDGE_ACCELERATE_AFTER
    ? NUDGE_REPEAT_MS
    : NUDGE_REPEAT_FAST_MS;
}

/**
 * How far past a soft boundary (the playhead, a chapter, a neighbouring clip
 * or pending edge) the finger must push an armed drag before the target
 * leaves it (px). More than `TOUCH_SLOP_PX`, so a resting finger's natural
 * drift never pops a detent, and a deliberate push always does.
 */
export const DRAG_DETENT_PX = 16;

/**
 * The compact inspector drawer (#1051 round 4b): a swipe on its header must
 * travel this far, or release at this speed (px/ms, about a quick flick), to
 * change detent; anything less snaps back. The travel matches
 * `SWIPE_MAX_DY_PX` below, the distance that already tells a swipe from a
 * press.
 */
export const DRAWER_SWIPE_MIN_PX = 24;
export const DRAWER_FLICK_PX_PER_MS = 0.5;

/** A clip-body press must travel this far (any direction) before it becomes a move. */
export const MOVE_THRESHOLD_PX = 5;

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

/** Max leftward visual offset (px) of a card while it is being swiped. */
export const SWIPE_MAX_TRANSLATE_PX = SWIPE_MIN_DX_PX * 2;

/** Card offset for a horizontal drag delta: leftward only, capped. */
export function swipeDragOffset(dx: number): number {
  return Math.max(-SWIPE_MAX_TRANSLATE_PX, Math.min(0, dx));
}

/** True while `at` (a `Date.now()` stamp) is inside the ghost-click window. */
export function withinGhostClick(at: number, now = Date.now()): boolean {
  return now - at < GHOST_CLICK_MS;
}
