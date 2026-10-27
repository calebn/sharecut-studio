import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";
import {
  type HandleEdge,
  type HandleStep,
  handleStep,
} from "./scriptSelection";

/** Where a handle's caret sits inside the scrolling text: its left edge, its top and the line's height, in pixels. */
export type HandlePlace = { x: number; y: number; height: number };

export type SelectionHandlesProps = {
  start: HandlePlace;
  end: HandlePlace;
  /** Each edge's place among the `count` places the keyboard stops, counted from 1. */
  startAt: number;
  endAt: number;
  count: number;
  /** What the edge sits on, for a screen reader: "before small". */
  startText: string;
  endText: string;
  /**
   * An edge was dragged. `x` and `y` are the client point of the caret itself,
   * not the finger, so a thumb below the line still points at the line.
   */
  onDrag: (edge: HandleEdge, point: { x: number; y: number }) => void;
  /** A key moved an edge: one place on or back, or to the first or last. */
  onStep: (edge: HandleEdge, step: HandleStep) => void;
};

type Grab = { pointerId: number; dx: number; dy: number };

/**
 * The two grips at the ends of a run of words (design-system element 13). A
 * handle is a slider over the places the keyboard stops: right or up is one
 * place on for either edge, so the start handle shrinks the run and the end
 * handle grows it. Drag reports the point under the caret; the host turns it
 * into a word. The handles are not tab stops, because Shift and Alt+Shift with
 * the arrows do the same from the words.
 *
 * Render them inside the scrolling, positioned container that holds the text.
 */
export function SelectionHandles({
  start,
  end,
  startAt,
  endAt,
  count,
  startText,
  endText,
  onDrag,
  onStep,
}: SelectionHandlesProps) {
  const grab = useRef<Grab | null>(null);

  const onDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    grab.current = {
      pointerId: event.pointerId,
      dx: event.clientX - (rect.left + rect.width / 2),
      dy: event.clientY - (rect.top + rect.height / 2),
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    event.preventDefault();
  };
  const onMove = (edge: HandleEdge) => (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    onDrag(edge, { x: event.clientX - held.dx, y: event.clientY - held.dy });
  };
  const onUp = () => {
    grab.current = null;
  };
  const onKey = (edge: HandleEdge) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = handleStep(event.key);
    if (step === null) return;
    event.preventDefault();
    onStep(edge, step);
  };

  const handle = (
    edge: HandleEdge,
    place: HandlePlace,
    at: number,
    text: string,
  ) => (
    <div
      className="sys-handle"
      data-edge={edge}
      role="slider"
      tabIndex={-1}
      aria-label={edge === "start" ? "Selection start" : "Selection end"}
      aria-orientation="horizontal"
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={at}
      aria-valuetext={text}
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
      onKeyDown={onKey(edge)}
    >
      <span className="sys-handle-knob" aria-hidden="true" />
    </div>
  );

  return (
    <>
      {handle("start", start, startAt, startText)}
      {handle("end", end, endAt, endText)}
    </>
  );
}
