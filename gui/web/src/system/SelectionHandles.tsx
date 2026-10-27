import type { CSSProperties, PointerEvent } from "react";
import { useRef } from "react";
import type { HandleEdge } from "./scriptSelection";

/** Where a handle's caret sits inside the scrolling text: its left edge, its top and the line's height, in pixels. */
export type HandlePlace = { x: number; y: number; height: number };

export type SelectionHandlesProps = {
  start: HandlePlace;
  end: HandlePlace;
  /**
   * An edge was dragged. `x` and `y` are the client point of the caret itself,
   * not the finger, so a thumb below the line still points at the line.
   */
  onDrag: (edge: HandleEdge, point: { x: number; y: number }) => void;
  /** A grip was taken, before any move. */
  onGrab?: () => void;
  /** The grip was let go, the browser took the touch, or it lost its pointer capture. */
  onRelease?: () => void;
};

type Grab = {
  pointerId: number;
  dx: number;
  dy: number;
  fromX: number;
  fromY: number;
  moved: boolean;
};

/**
 * Chrome snaps a touch to the nearest element that answers to a click, and a
 * word button does while a div with only pointer handlers does not, so the
 * upper part of the knob would grab the word beside it. A click listener on the
 * grip itself, which React's delegated handlers do not provide, makes the grip
 * a candidate too. It also keeps the click the browser synthesises after a tap
 * from reaching anything under the grip.
 */
const swallowClick = (grip: HTMLElement | null) => {
  if (!grip) return;
  const stop = (event: Event) => event.preventDefault();
  grip.addEventListener("click", stop);
  return () => grip.removeEventListener("click", stop);
};

/** Farther than this and a press is a drag; a finger rolls a few pixels on a tap. */
const TAP_SLOP = 4;

/**
 * The two grips at the ends of a run of words (design-system element 13).
 * They are pointer-only and hidden from assistive tech: the keyboard and a
 * screen reader move the selection from the words (Shift+arrows grow it,
 * Alt+Shift+Left or Right moves its start), so a grip is not a widget with
 * its own keys and not a tab stop.
 *
 * Each grip's hit region reaches only toward its knob, the start's above its
 * line and the end's below, so it covers no word on its own line. A press
 * that never moves is passed to whatever button lies under the point, so a
 * tap near a grip still lands on the word beside it, with the press's Shift,
 * Ctrl, Alt and Meta keys replayed so a Shift-tap there still extends. Drag reports the point
 * under the caret; the host turns it into a word.
 *
 * Render them inside the scrolling, positioned container that holds the text.
 */
export function SelectionHandles({
  start,
  end,
  onDrag,
  onGrab,
  onRelease,
}: SelectionHandlesProps) {
  const grab = useRef<Grab | null>(null);

  const onDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    grab.current = {
      pointerId: event.pointerId,
      dx: event.clientX - (rect.left + rect.width / 2),
      dy: event.clientY - (rect.top + rect.height / 2),
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    event.preventDefault();
    onGrab?.();
  };
  const onMove = (edge: HandleEdge) => (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (
      !held.moved &&
      Math.hypot(event.clientX - held.fromX, event.clientY - held.fromY) <=
        TAP_SLOP
    ) {
      return;
    }
    held.moved = true;
    onDrag(edge, { x: event.clientX - held.dx, y: event.clientY - held.dy });
  };
  const onUp = (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    onRelease?.();
    if (held.moved || event.type === "pointercancel") return;
    const under = event.currentTarget.ownerDocument.elementsFromPoint?.(
      event.clientX,
      event.clientY,
    );
    const target = under
      ?.map((el) => el.closest<HTMLElement>("button"))
      .find((el) => el !== null);
    if (!target) return;
    const { shiftKey, ctrlKey, altKey, metaKey } = event;
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey,
        ctrlKey,
        altKey,
        metaKey,
      }),
    );
  };
  const onLost = (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    onRelease?.();
  };

  const handle = (edge: HandleEdge, place: HandlePlace) => (
    <div
      ref={swallowClick}
      className="sys-handle"
      data-edge={edge}
      aria-hidden="true"
      style={
        {
          insetInlineStart: place.x,
          insetBlockStart: place.y,
          blockSize: place.height,
        } as CSSProperties
      }
      onPointerDown={onDown}
      onPointerMove={onMove(edge)}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onLost}
    >
      <span className="sys-handle-knob" />
    </div>
  );

  return (
    <>
      {handle("start", start)}
      {handle("end", end)}
    </>
  );
}
