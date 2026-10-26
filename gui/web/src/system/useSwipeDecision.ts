import { type PointerEvent, useRef, useState } from "react";
import {
  releaseSwipe,
  type SwipeIntent,
  type SwipeState,
  swipeState,
} from "./swipeDecision";

type Handlers = Partial<Record<SwipeIntent, () => void>>;

type SwipeDrag = SwipeState & { dx: number; dy: number };

/** What a row can start a swipe on: the row's own button is not excluded. */
export const SWIPE_IGNORE_ROW = "input, textarea, select, a";
const SWIPE_IGNORE_CARD = `button, ${SWIPE_IGNORE_ROW}, [role='slider']`;
const TAP_SLOP_PX = 8;

/** A direction without a handler springs back. Vibrates on commit where the device can. */
export function useSwipeDecision(
  handlers: Handlers,
  {
    disabled = false,
    ignore = SWIPE_IGNORE_CARD,
  }: { disabled?: boolean; ignore?: string } = {},
) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const captured = useRef(false);
  const [drag, setDrag] = useState<SwipeDrag | null>(null);

  const finish = (event: PointerEvent, commit: boolean) => {
    const origin = start.current;
    start.current = null;
    setDrag(null);
    if (!origin || !commit) return;
    const intent = releaseSwipe(
      event.clientX - origin.x,
      event.clientY - origin.y,
    );
    const act = intent ? handlers[intent] : undefined;
    if (act) {
      navigator.vibrate?.(10);
      act();
    }
  };

  return {
    drag,
    /** True after a drag, so the click that ends it can be ignored. */
    wasDrag: () => {
      const was = moved.current;
      moved.current = false;
      return was;
    },
    bind: disabled
      ? {}
      : {
          onPointerDown: (event: PointerEvent) => {
            if (!event.isPrimary || (event.target as Element).closest(ignore))
              return;
            moved.current = false;
            captured.current = false;
            start.current = {
              x: event.clientX,
              y: event.clientY,
              id: event.pointerId,
            };
          },
          onPointerMove: (event: PointerEvent) => {
            const origin = start.current;
            if (!origin || origin.id !== event.pointerId) return;
            const dx = event.clientX - origin.x;
            const dy = event.clientY - origin.y;
            if (Math.hypot(dx, dy) > TAP_SLOP_PX) {
              moved.current = true;
              if (!captured.current) {
                captured.current = true;
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // A synthetic pointer has nothing to capture.
                }
              }
            }
            setDrag({ ...swipeState(dx, dy), dx, dy });
          },
          onPointerUp: (event: PointerEvent) => finish(event, true),
          onPointerCancel: (event: PointerEvent) => finish(event, false),
        },
  };
}
