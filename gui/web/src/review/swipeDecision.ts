export const SWIPE_THRESHOLD_PX = 80;

export type SwipeIntent = "verb" | "keep" | "next";

export type SwipeState = {
  intent: SwipeIntent | null;
  /** Distance along the leading axis over the threshold, 0 to 1. */
  progress: number;
  /** True once releasing would decide. */
  committed: boolean;
};

const NONE: SwipeState = { intent: null, progress: 0, committed: false };

/** Right does the verb, left keeps, up moves on. The longer axis leads. */
export function swipeState(dx: number, dy: number): SwipeState {
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const distance = horizontal ? Math.abs(dx) : -dy;
  if (distance <= 0) return NONE;
  const intent: SwipeIntent = horizontal ? (dx > 0 ? "verb" : "keep") : "next";
  return {
    intent,
    progress: Math.min(1, distance / SWIPE_THRESHOLD_PX),
    committed: distance >= SWIPE_THRESHOLD_PX,
  };
}

export type SwipeRelease =
  | { commit: SwipeIntent; springBack: false }
  | { commit: null; springBack: boolean };

/** Below the threshold nothing is decided and the card springs back. */
export function releaseSwipe(dx: number, dy: number): SwipeRelease {
  const state = swipeState(dx, dy);
  if (state.committed && state.intent) {
    return { commit: state.intent, springBack: false };
  }
  return { commit: null, springBack: dx !== 0 || dy !== 0 };
}
