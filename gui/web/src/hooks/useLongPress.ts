import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from "react";
import {
  GHOST_CLICK_MS,
  LONG_PRESS_MOVE_CANCEL_PX,
  LONG_PRESS_MS,
  withinGhostClick,
} from "./touchGestureTiming";

export type LongPressHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => boolean;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
};

const CAPTURE = { capture: true } as const;

/**
 * Touch-only long press recognizer; movement, cancellation, and multi-touch
 * abort it. The callback runs on release: it consumes the synthesized click,
 * or fires after {@link GHOST_CLICK_MS} for browsers that omit that click.
 * A released-but-unfired press is flushed (not dropped) by the next
 * pointerdown anywhere, and a click arriving just after the fallback fired
 * is swallowed so the gesture never double-fires.
 */
export function useLongPress(
  onLongPress: (target: EventTarget | null) => void,
): LongPressHandlers {
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
  const removePendingListenerRef = useRef<() => void>(() => undefined);
  const firedAtRef = useRef(-Infinity);
  const removeListenersRef = useRef<() => void>(() => undefined);

  /** Stop tracking the current press; an already-released press stays pending. */
  const disarm = () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
    readyRef.current = false;
    removeListenersRef.current();
    removeListenersRef.current = () => undefined;
  };

  const clearPending = () => {
    if (pendingRef.current != null) clearTimeout(pendingRef.current);
    pendingRef.current = null;
    pendingTargetRef.current = null;
    removePendingListenerRef.current();
    removePendingListenerRef.current = () => undefined;
  };

  const firePending = () => {
    if (pendingRef.current == null) return;
    const target = pendingTargetRef.current;
    clearPending();
    firedAtRef.current = Date.now();
    callbackRef.current(target);
  };

  const move = (event: PointerEvent | ReactPointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (
      origin &&
      (origin.id !== event.pointerId ||
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
          LONG_PRESS_MOVE_CANCEL_PX)
    ) {
      disarm();
    }
  };

  const up = (event: PointerEvent | ReactPointerEvent<HTMLElement>) => {
    const fire = readyRef.current && originRef.current?.id === event.pointerId;
    const target = originRef.current?.target ?? event.target;
    disarm();
    if (fire) {
      clearPending();
      // Consume the synthesized click before opening a sheet over its target.
      // Some browsers omit click after a held touch, so retain a fallback.
      pendingTargetRef.current = target;
      pendingRef.current = setTimeout(firePending, GHOST_CLICK_MS);
      // Any other press (even on another recognizer) flushes this one first
      // so the newer interaction wins instead of being overridden later.
      window.addEventListener("pointerdown", firePending, CAPTURE);
      removePendingListenerRef.current = () =>
        window.removeEventListener("pointerdown", firePending, CAPTURE);
    }
    return fire;
  };

  const teardown = () => {
    disarm();
    clearPending();
  };
  useEffect(() => teardown, []);

  return {
    onPointerDown: (event) => {
      firePending();
      disarm();
      firedAtRef.current = -Infinity;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      originRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: event.target,
      };
      // Capture phase: a second finger must abort even when the element it
      // lands on calls stopPropagation (clips, markers, envelopes).
      const onDown = (next: PointerEvent) => {
        if (originRef.current && originRef.current.id !== next.pointerId)
          disarm();
      };
      // Suppress the native callout / selection menu while a press is armed.
      const onContextMenu = (next: Event) => next.preventDefault();
      window.addEventListener("pointerdown", onDown, CAPTURE);
      window.addEventListener("contextmenu", onContextMenu, CAPTURE);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", disarm);
      removeListenersRef.current = () => {
        window.removeEventListener("pointerdown", onDown, CAPTURE);
        window.removeEventListener("contextmenu", onContextMenu, CAPTURE);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", disarm);
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
    onPointerCancel: disarm,
    onClickCapture: (event) => {
      if (pendingRef.current != null) {
        event.preventDefault();
        event.stopPropagation();
        firePending();
        return;
      }
      // Late synthesized click after the fallback already fired.
      if (withinGhostClick(firedAtRef.current)) {
        firedAtRef.current = -Infinity;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
