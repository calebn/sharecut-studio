import { type PointerEvent, useRef, useState } from "react";
import {
  releaseSwipe,
  type SwipeIntent,
  type SwipeState,
  swipeState,
} from "./swipeDecision";

type Handlers = Partial<Record<SwipeIntent, () => void>>;

export type SwipeDrag = SwipeState & { dx: number; dy: number };

const INTERACTIVE = "button, input, textarea, select, a, [role='slider']";
const TAP_SLOP_PX = 8;

/**
 * Pointer swipes for a card or row. A direction without a handler springs
 * back. Haptic feedback fires on commit where the device has it.
 */
export function useSwipeDecision(
  handlers: Handlers,
  {
    disabled = false,
    ignore = INTERACTIVE,
  }: { disabled?: boolean; ignore?: string } = {},
) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const [drag, setDrag] = useState<SwipeDrag | null>(null);

  const finish = (event: PointerEvent, commit: boolean) => {
    const origin = start.current;
    start.current = null;
    setDrag(null);
    if (!origin || !commit) return;
    const release = releaseSwipe(
      event.clientX - origin.x,
      event.clientY - origin.y,
    );
    if (release.commit && handlers[release.commit]) {
      navigator.vibrate?.(10);
      handlers[release.commit]?.();
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
            start.current = {
              x: event.clientX,
              y: event.clientY,
              id: event.pointerId,
            };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // A synthetic pointer has nothing to capture.
            }
          },
          onPointerMove: (event: PointerEvent) => {
            const origin = start.current;
            if (!origin || origin.id !== event.pointerId) return;
            const dx = event.clientX - origin.x;
            const dy = event.clientY - origin.y;
            if (Math.hypot(dx, dy) > TAP_SLOP_PX) moved.current = true;
            setDrag({ ...swipeState(dx, dy), dx, dy });
          },
          onPointerUp: (event: PointerEvent) => finish(event, true),
          onPointerCancel: (event: PointerEvent) => finish(event, false),
        },
  };
}
