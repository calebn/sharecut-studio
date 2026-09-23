import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import {
  LONG_PRESS_MS,
  SWIPE_MAX_DY_PX,
  SWIPE_MIN_DX_PX,
  swipeDragOffset,
  withinGhostClick,
} from "./touchGestureTiming";

export type SwipeLeftHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Forget an in-flight swipe (e.g. a long-press claimed the press). */
  reset: () => void;
  /** True while the click synthesized by a completed swipe may still land. */
  justSwiped: () => boolean;
  /** Leftward drag offset in px (≤ 0) while a swipe is tracked; 0 when idle. */
  offsetPx: number;
  /** True once the drag has travelled far enough that release would resolve. */
  armed: boolean;
};

/**
 * Touch-only horizontal swipe-left recognizer. It must finish before a
 * long-press would ({@link LONG_PRESS_MS}) and gives up once vertical travel
 * says the user is scrolling. `enabled` is read at release time. It also
 * reports `offsetPx`/`armed` for live drag feedback while a swipe is
 * tracked; the offset only tracks while `enabled`.
 */
export function useSwipeLeft(
  enabled: boolean,
  onSwipe: () => void,
): SwipeLeftHandlers {
  const startRef = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
  } | null>(null);
  const swipedAtRef = useRef(-Infinity);
  const [offsetPx, setOffsetPx] = useState(0);
  const reset = () => {
    startRef.current = null;
    setOffsetPx(0);
  };
  return {
    onPointerDown: (event) => {
      startRef.current =
        event.pointerType === "touch" && event.isPrimary
          ? {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              at: Date.now(),
            }
          : null;
    },
    onPointerMove: (event) => {
      const start = startRef.current;
      if (!start) return;
      if (
        start.id !== event.pointerId ||
        Math.abs(event.clientY - start.y) >= SWIPE_MAX_DY_PX ||
        Date.now() - start.at >= LONG_PRESS_MS
      ) {
        reset();
        return;
      }
      if (enabled) setOffsetPx(swipeDragOffset(event.clientX - start.x));
    },
    onPointerUp: (event) => {
      const start = startRef.current;
      reset();
      if (
        !start ||
        !enabled ||
        start.id !== event.pointerId ||
        Date.now() - start.at >= LONG_PRESS_MS
      ) {
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx <= -SWIPE_MIN_DX_PX && Math.abs(dy) < SWIPE_MAX_DY_PX) {
        swipedAtRef.current = Date.now();
        onSwipe();
      }
    },
    onPointerCancel: reset,
    reset,
    justSwiped: () => withinGhostClick(swipedAtRef.current),
    offsetPx,
    armed: offsetPx <= -SWIPE_MIN_DX_PX,
  };
}
