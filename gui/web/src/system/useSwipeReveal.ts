import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { TOUCH_SLOP_PX } from "../hooks/gestureConstants";

type Origin = {
  id: number;
  x: number;
  y: number;
  from: number;
  locked: boolean;
};

export type SwipeReveal = {
  revealed: boolean;
  dragging: boolean;
  /** Offsets the sliding row while a finger drags it. */
  style: CSSProperties | undefined;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  };
};

/**
 * A touch swipe to the left slides a row over to show the action behind it
 * (`.sys-project-remove`, inside the element `cardRef` names); a swipe to the
 * right, a tap elsewhere or a tap on the row hides it again. The row's own click is swallowed after a swipe so a drag
 * never opens the card.
 */
export function useSwipeReveal(
  enabled: boolean,
  cardRef: RefObject<HTMLDivElement | null>,
): SwipeReveal {
  const [revealed, setRevealed] = useState(false);
  const [offset, setOffset] = useState<number | null>(null);
  const origin = useRef<Origin | null>(null);
  const swallowClick = useRef(false);

  useEffect(() => {
    if (!revealed) return;
    const away = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) setRevealed(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [revealed, cardRef]);

  const width = () =>
    cardRef.current?.querySelector<HTMLElement>(".sys-project-remove")
      ?.offsetWidth ?? 0;

  const settle = (event: ReactPointerEvent<HTMLElement>) => {
    const start = origin.current;
    origin.current = null;
    if (!start?.locked) {
      setOffset(null);
      return;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const next = Math.min(
      0,
      Math.max(-width(), start.from + dxOf(event, start)),
    );
    setRevealed(next < -width() / 2);
    setOffset(null);
  };

  return {
    revealed,
    dragging: offset !== null,
    style:
      offset === null
        ? undefined
        : ({ "--project-swipe": `${offset}px` } as CSSProperties),
    handlers: {
      onPointerDown: (event) => {
        swallowClick.current = false;
        if (!enabled || event.pointerType !== "touch" || !event.isPrimary)
          return;
        origin.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          from: revealed ? -width() : 0,
          locked: false,
        };
      },
      onPointerMove: (event) => {
        const start = origin.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = dxOf(event, start);
        if (!start.locked) {
          const dy = event.clientY - start.y;
          if (Math.abs(dx) <= TOUCH_SLOP_PX && Math.abs(dy) <= TOUCH_SLOP_PX)
            return;
          if (Math.abs(dy) > Math.abs(dx)) {
            origin.current = null;
            return;
          }
          start.locked = true;
          swallowClick.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        setOffset(Math.min(0, Math.max(-width(), start.from + dx)));
      },
      onPointerUp: settle,
      onPointerCancel: () => {
        origin.current = null;
        setOffset(null);
      },
      onClickCapture: (event) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (revealed) {
          event.preventDefault();
          event.stopPropagation();
          setRevealed(false);
        }
      },
    },
  };
}

function dxOf(
  event: ReactPointerEvent<HTMLElement>,
  start: Pick<Origin, "x">,
): number {
  return event.clientX - start.x;
}
