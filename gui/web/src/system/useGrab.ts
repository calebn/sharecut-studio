import { type PointerEvent, useEffect, useRef } from "react";
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { useStableCallback } from "../utils/useStableCallback";
import { capturePointer } from "./wavePointer";

export type GrabPointer = {
  clientX: number;
  clientY: number;
  shift: boolean;
  alt: boolean;
};

export type GrabMove = GrabPointer & {
  dx: number;
  dy: number;
};

type GrabOptions<G> = {
  canGrab: (grip: G, event: PointerEvent<HTMLElement>) => boolean;
  slop?: (grip: G, event: PointerEvent<HTMLElement>) => number;
  /** A node moved in the DOM loses its pointer capture, so a lasting ancestor takes it when the drag starts. */
  captureOnStart?: () => HTMLElement | null;
  onStart: (
    grip: G,
    pointer: GrabPointer,
    press: GrabPointer,
  ) => boolean | undefined;
  onMove: (grip: G, move: GrabMove) => void;
  onEnd: (grip: G, committed: boolean) => void;
};

type Grab<G> = {
  grip: G;
  pointerId: number;
  fromX: number;
  fromY: number;
  press: GrabPointer;
  moved: boolean;
};

function pointerOf(
  event: PointerEvent<HTMLElement> | globalThis.PointerEvent,
): GrabPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** A tap that never passes the slop reports nothing, so the click that follows is the owner's to read. */
export function useGrab<G>(options: GrabOptions<G>) {
  const held = useRef<Grab<G> | null>(null);
  const dragged = useRef(false);
  const canGrab = useStableCallback(options.canGrab);
  const slopOf = useStableCallback(
    (grip: G, event: PointerEvent<HTMLElement>) =>
      options.slop?.(grip, event) ?? HANDLE_DRAG_MIN_PX,
  );
  const onStart = useStableCallback(options.onStart);
  const onMove = useStableCallback(options.onMove);
  const onEnd = useStableCallback(options.onEnd);

  const watching = useRef<AbortController | null>(null);

  const stopWatching = useStableCallback(() => {
    watching.current?.abort();
    watching.current = null;
  });
  const abort = useStableCallback(() => {
    const grab = held.current;
    stopWatching();
    if (!grab) return;
    held.current = null;
    if (!grab.moved) return;
    dragged.current = true;
    onEnd(grab.grip, false);
  });
  const escapeDrag = useStableCallback((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || !held.current?.moved) return;
    event.preventDefault();
    event.stopPropagation();
    abort();
  });

  useEffect(() => abort, [abort]);

  const down = (grip: G) => (event: PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (!canGrab(grip, event)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (held.current && held.current.pointerId !== event.pointerId) return;
    held.current = {
      grip,
      pointerId: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      press: pointerOf(event),
      moved: false,
    };
    stopWatching();
    const { signal } = (watching.current = new AbortController());
    document.addEventListener("keydown", escapeDrag, { capture: true, signal });
    window.addEventListener("blur", abort, { signal });
    capturePointer(event);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const grab = held.current;
    if (!grab || grab.pointerId !== event.pointerId) return;
    const dx = event.clientX - grab.fromX;
    const dy = event.clientY - grab.fromY;
    if (!grab.moved) {
      const slop = slopOf(grab.grip, event);
      if (Math.abs(dx) < slop) return;
      grab.moved = true;
      if (onStart(grab.grip, pointerOf(event), grab.press) === false) {
        held.current = null;
        stopWatching();
        dragged.current = false;
        return;
      }
      try {
        options.captureOnStart?.()?.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer id has nothing to capture.
      }
    }
    onMove(grab.grip, { ...pointerOf(event), dx, dy });
  };
  const finish = (committed: boolean) => (event: PointerEvent<HTMLElement>) => {
    const grab = held.current;
    if (!grab || grab.pointerId !== event.pointerId) return;
    held.current = null;
    stopWatching();
    if (!grab.moved) return;
    dragged.current = true;
    onEnd(grab.grip, committed);
  };

  const up = finish(true);
  const cancel = finish(false);

  return {
    handlers: (grip: G) => ({
      onPointerDown: down(grip),
      onPointerMove: move,
      onPointerUp: up,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    }),
    press: (grip: G, event: PointerEvent<HTMLElement>) => down(grip)(event),
    move,
    up,
    cancel,
    active: (): G | null => held.current?.grip ?? null,
    abort,
    consumeClick: (): boolean => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}
