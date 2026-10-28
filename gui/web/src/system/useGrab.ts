import { type PointerEvent, useEffect, useRef } from "react";
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { useStableCallback } from "../utils/useStableCallback";
import { capturePointer } from "./wavePointer";

/** Where the pointer is and which keys are down. */
export type GrabPointer = {
  clientX: number;
  clientY: number;
  /** Shift is held. */
  shift: boolean;
  /** Alt is held; the host turns snapping off. */
  alt: boolean;
};

export type GrabMove = GrabPointer & {
  /** Pixels from where the press began. */
  dx: number;
  dy: number;
};

type GrabOptions<G> = {
  /** Whether this press may start a grab: a finger on an unselected mark, a read-only view. */
  canGrab: (grip: G, event: PointerEvent<HTMLElement>) => boolean;
  /** Pixels of travel that turn a press into a drag, 3 unless a grip says otherwise. */
  slop?: (grip: G, event: PointerEvent<HTMLElement>) => number;
  /**
   * The element that takes the pointer once the drag starts. The pressed mark
   * may be moved in the DOM while it is dragged, and a moved node loses its
   * capture, so a lasting ancestor holds it from then on.
   */
  captureOnStart?: () => HTMLElement | null;
  /** First movement past the slop. Return `false` to refuse the drag. */
  onStart: (
    grip: G,
    pointer: GrabPointer,
    press: GrabPointer,
  ) => boolean | undefined;
  onMove: (grip: G, move: GrabMove) => void;
  /** `committed` is false when Escape, a blur, the browser or a lost capture ended it. */
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

/**
 * The pointer lifecycle every dragged mark shares. One pointer has hold at a
 * time and a second is ignored. The drag starts after the slop, and Escape from
 * the document, a window blur, `pointercancel`, a lost capture or the owner
 * unmounting all end it as not committed. A tap that never moves reports
 * nothing, so the click that follows is the owner's to read.
 */
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

  const stopWatching = useStableCallback(() => {
    document.removeEventListener("keydown", escapeDrag, true);
    window.removeEventListener("blur", abort);
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
    document.addEventListener("keydown", escapeDrag, true);
    window.addEventListener("blur", abort);
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
        // A synthetic pointer has nothing to capture.
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
    /** The pointer handlers to spread on the element that starts `grip`. */
    handlers: (grip: G) => ({
      onPointerDown: down(grip),
      onPointerMove: move,
      onPointerUp: up,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    }),
    /** The same handlers one at a time, for an owner that routes many marks through one set of callbacks. */
    press: (grip: G, event: PointerEvent<HTMLElement>) => down(grip)(event),
    move,
    up,
    cancel,
    /** The grip being dragged or pressed, if any. */
    active: (): G | null => held.current?.grip ?? null,
    /** Ends a drag as not committed, for an owner whose grip went away. */
    abort,
    /** True once after a drag, so the click the browser sends on release is not read as a tap. */
    consumeClick: (): boolean => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}
