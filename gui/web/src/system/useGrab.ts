import { type PointerEvent, useEffect, useLayoutEffect, useRef } from "react";
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { listenForInterrupt } from "../hooks/useInterruptCancel";
import { useStableCallback } from "../utils/useStableCallback";
import { capturePointer } from "./wavePointer";

export function listenForDragEscape(
  isDragging: () => boolean,
  cancel: () => void,
  signal: AbortSignal,
): void {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isDragging()) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
    { capture: true, signal },
  );
}

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
  coalesceMoves?: (grip: G) => boolean;
  /** A node moved in the DOM loses its pointer capture, so a lasting ancestor takes it when the drag starts. */
  captureOnStart?: () => HTMLElement | null;
  onStart: (
    grip: G,
    pointer: GrabPointer,
    press: GrabPointer,
  ) => boolean | undefined;
  /** `at` is the move event's `timeStamp`, ms on the `performance.now` clock: when the finger was there, however late the handler runs. */
  onMove: (grip: G, move: GrabMove, at: number) => void;
  /** `at` is the release event's `timeStamp`; an abort has no event and reads `performance.now()`. */
  onEnd: (grip: G, committed: boolean, at: number) => void;
};

type MoveSample = { move: GrabMove; at: number };
type PendingMove = { frame: number; sample: MoveSample };

type Grab<G> = {
  grip: G;
  pointerId: number;
  fromX: number;
  fromY: number;
  press: GrabPointer;
  moved: boolean;
  coalesceMoves: boolean;
  pendingMove: PendingMove | null;
};

function takePendingMove<G>(grab: Grab<G> | null): MoveSample | undefined {
  if (!grab?.pendingMove) return;
  const { frame, sample } = grab.pendingMove;
  grab.pendingMove = null;
  cancelAnimationFrame(frame);
  return sample;
}

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
    takePendingMove(grab);
    if (!grab.moved) return;
    dragged.current = true;
    onEnd(grab.grip, false, performance.now());
  });

  useLayoutEffect(
    () => () => {
      takePendingMove(held.current);
    },
    [],
  );
  useEffect(() => abort, [abort]);

  const down = (grip: G) => (event: PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (!canGrab(grip, event)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (held.current && held.current.pointerId !== event.pointerId) return;
    takePendingMove(held.current);
    held.current = {
      grip,
      pointerId: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      press: pointerOf(event),
      moved: false,
      coalesceMoves: options.coalesceMoves?.(grip) ?? false,
      pendingMove: null,
    };
    stopWatching();
    const { signal } = (watching.current = new AbortController());
    listenForDragEscape(() => held.current?.moved === true, abort, signal);
    listenForInterrupt(abort, signal);
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
    const change = {
      ...pointerOf(event),
      dx: event.clientX - grab.fromX,
      dy: event.clientY - grab.fromY,
    };
    if (!grab.coalesceMoves) {
      onMove(grab.grip, change, event.timeStamp);
      return;
    }
    const sample = { move: change, at: event.timeStamp };
    if (grab.pendingMove) {
      grab.pendingMove.sample = sample;
      return;
    }
    const pending: PendingMove = {
      sample,
      frame: requestAnimationFrame(() => {
        if (held.current !== grab || grab.pendingMove !== pending) return;
        grab.pendingMove = null;
        onMove(grab.grip, pending.sample.move, pending.sample.at);
      }),
    };
    grab.pendingMove = pending;
  };
  const finish = (committed: boolean) => (event: PointerEvent<HTMLElement>) => {
    const grab = held.current;
    if (!grab || grab.pointerId !== event.pointerId) return;
    held.current = null;
    stopWatching();
    if (!grab.moved) return;
    dragged.current = true;
    const pending = takePendingMove(grab);
    if (committed && pending) onMove(grab.grip, pending.move, pending.at);
    onEnd(grab.grip, committed, event.timeStamp);
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
    /** Forget the click an earlier gesture left behind; a new press at the owner's root calls it, since the next click belongs to that press. */
    clearClick: () => {
      dragged.current = false;
    },
    /** True for the click a pointer gesture leaves behind; a key press (`detail` 0) is never swallowed. */
    consumeClick: (event: { detail: number }): boolean => {
      const was = dragged.current;
      dragged.current = false;
      return was && event.detail > 0;
    },
  };
}
