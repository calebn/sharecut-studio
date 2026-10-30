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
  /** The direction the slop is measured along; the default is horizontal. `both` measures the distance from the press, for a grip that moves in both. */
  axis?: "x" | "y" | "both";
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

/** The keys a part ignores while one of its drags is moving; Escape and the Alt focus walk stay live. */
export function swallowsDuringDrag(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    !(event.ctrlKey || event.metaKey || event.altKey) &&
    DRAG_SWALLOWED.has(event.key)
  );
}

const DRAG_SWALLOWED: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  " ",
]);

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
 * A tap that never passes the slop reports nothing, so the click that follows is the owner's to read.
 * A finger drag counts from the point where it passed the slop, so the first move does not jump by it.
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
    if (!grab.moved) {
      const across = event.clientX - grab.fromX;
      const down = event.clientY - grab.fromY;
      const along =
        options.axis === "y"
          ? down
          : options.axis === "both"
            ? Math.hypot(across, down)
            : across;
      const slop = slopOf(grab.grip, event);
      if (Math.abs(along) < slop) return;
      grab.moved = true;
      if (event.pointerType === "touch" || event.pointerType === "pen") {
        grab.fromX = event.clientX;
        grab.fromY = event.clientY;
        grab.press = pointerOf(event);
      }
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
    onMove(grab.grip, {
      ...pointerOf(event),
      dx: event.clientX - grab.fromX,
      dy: event.clientY - grab.fromY,
    });
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
    /** True from the first move past the slop; a press that has not moved is not a drag yet. */
    dragging: (): boolean => held.current?.moved === true,
    abort,
    /** True for the click a pointer gesture leaves behind; a key press (`detail` 0) is never swallowed. */
    consumeClick: (event: { detail: number }): boolean => {
      const was = dragged.current;
      dragged.current = false;
      return was && event.detail > 0;
    },
  };
}
