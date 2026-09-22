import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from "react";

const LONG_PRESS_MS = 550;
const MOVE_CANCEL_PX = 12;

type PointerHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => boolean;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
};

/** Touch-only long press recognizer; movement, cancellation, and multi-touch abort it. */
export function useLongPress(
  onLongPress: (target: EventTarget | null) => void,
): PointerHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{
    id: number;
    x: number;
    y: number;
    target: EventTarget | null;
  } | null>(null);
  const readyRef = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTargetRef = useRef<EventTarget | null>(null);
  const removeListenersRef = useRef<() => void>(() => undefined);

  const cancel = () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
    readyRef.current = false;
    removeListenersRef.current();
    removeListenersRef.current = () => undefined;
    if (pendingRef.current != null) clearTimeout(pendingRef.current);
    pendingRef.current = null;
    pendingTargetRef.current = null;
  };

  const move = (event: PointerEvent | ReactPointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (
      origin &&
      (origin.id !== event.pointerId ||
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
          MOVE_CANCEL_PX)
    ) {
      cancel();
    }
  };

  const up = (event: PointerEvent | ReactPointerEvent<HTMLElement>) => {
    const fire = readyRef.current && originRef.current?.id === event.pointerId;
    const target = originRef.current?.target ?? event.target;
    cancel();
    if (fire) {
      // Consume the synthesized click before opening a sheet over its target.
      // Some browsers omit click after a held touch, so retain a fallback.
      pendingTargetRef.current = target;
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        pendingTargetRef.current = null;
        callbackRef.current(target);
      }, 500);
    }
    return fire;
  };

  useEffect(() => cancel, []);

  return {
    onPointerDown: (event) => {
      cancel();
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      originRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: event.target,
      };
      const onDown = (next: PointerEvent) => {
        if (originRef.current && originRef.current.id !== next.pointerId)
          cancel();
      };
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      removeListenersRef.current = () => {
        window.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      timerRef.current = setTimeout(() => {
        if (originRef.current?.id === event.pointerId) {
          readyRef.current = true;
          timerRef.current = null;
        }
      }, LONG_PRESS_MS);
    },
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: cancel,
    onClickCapture: (event) => {
      if (pendingRef.current == null) return;
      const target = pendingTargetRef.current;
      cancel();
      event.preventDefault();
      event.stopPropagation();
      callbackRef.current(target);
    },
  };
}
