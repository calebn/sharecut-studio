import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";
import { HANDLE_DRAG_MIN_PX, TOUCH_SLOP_PX } from "../hooks/gestureConstants";
import { clamp } from "../utils/math";
import { formatRulerTime, formatTime } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import { rulerStep, rulerTicks, timeAtX, xAtTime } from "./rulerMath";
import type { TimeRange } from "./seconds";
import { type GrabMove, type GrabPointer, useGrab } from "./useGrab";

export type RulerEdge = "start" | "end";
type RulerGrip = "scrub" | RulerEdge;

/** `data-*` attributes (a hit target, a presence anchor) the host wants on the ruler's elements. */
export type RulerAttrs = Readonly<Record<string, string>>;

/** A recording session drawn as a band on the ruler; the host names it ("S2"). */
export type RulerSession = TimeRange & { label: string };

export type RulerPointer = GrabPointer;

export type RulerDrag = GrabMove & {
  /** Where the edge would sit under the pointer, in seconds, held to the episode. */
  seconds: number;
};

export type RulerNudge = {
  /** The key is auto-repeating: the same press, held. */
  repeat: boolean;
};

export type RulerProps = {
  /** Seconds at the ruler's left edge. */
  start: number;
  pxPerSecond: number;
  /** The ruler's width in px. The lane host that sizes the lanes passes the same three numbers to the marker lane. */
  width: number;
  /** The episode's length in seconds. Seeks and edges stop here. */
  duration: number;
  /** Where the playhead is, in seconds. */
  playhead: number;
  /** The current selection: a 4 px band along the bottom with a handle at each end. */
  selection?: TimeRange;
  /** Recording sessions, drawn as alternating bands behind the ticks. */
  sessions?: readonly RulerSession[];
  /** A guest seeks and scrubs but sees no selection handles. */
  readOnly?: boolean;
  /** The selection handles are 44 px; a coarse pointer does this by itself. */
  touch?: boolean;
  /** Names the slider. */
  label?: string;
  /** Attributes for the ruler's root, such as a presence anchor. */
  anchorProps?: RulerAttrs;
  /** Attributes for the body (`scrub`) and for each selection handle, such as `data-hit-*`. */
  hitProps?: Partial<Record<RulerGrip, RulerAttrs>>;
  /** A click, or Left, Right, Home or End on the ruler: move the playhead to `seconds`. */
  onSeek: (seconds: number) => void;
  /** A double-click: fit the episode in the window. */
  onFit?: () => void;
  /**
   * First movement of a drag on the ruler body, never on a tap. Return
   * `false` to refuse it.
   */
  onScrubStart?: (
    seconds: number,
    pointer: RulerPointer,
  ) => boolean | undefined;
  /** The pointer's time while a scrub goes on. */
  onScrub?: (seconds: number, pointer: RulerPointer) => void;
  /**
   * `committed` is false when Escape, a window blur, the browser, a lost
   * capture or the ruler leaving the page ended it: the host puts the
   * playhead back.
   */
  onScrubEnd?: (committed: boolean) => void;
  /** First movement of a drag on a selection handle. Return `false` to refuse it. */
  onSelectionDragStart?: (
    edge: RulerEdge,
    pointer: RulerPointer,
  ) => boolean | undefined;
  onSelectionDrag?: (edge: RulerEdge, drag: RulerDrag) => void;
  onSelectionDragEnd?: (edge: RulerEdge, committed: boolean) => void;
  /**
   * Left or Right on a focused selection handle: move the edge `seconds`
   * earlier (negative) or later. 10 ms, Shift 100 ms. A held key calls this
   * again with `repeat` set.
   */
  onSelectionNudge?: (
    edge: RulerEdge,
    seconds: number,
    nudge: RulerNudge,
  ) => void;
  /** The arrow was released, or focus left the handle: close the undo step. */
  onSelectionNudgeEnd?: (edge: RulerEdge) => void;
};

/** The shortest a selection handle lets the selection get, in seconds. */
export const RULER_MIN_SELECTION = 0.01;
const SELECTION_NUDGE = 0.01;
const SELECTION_NUDGE_BIG = 0.1;
/** Shift with Left or Right on the ruler moves the playhead this many ticks. */
const SEEK_BIG_TICKS = 10;
/** The playhead's triangle is 10 px wide; a half-visible one still shows. */
const PLAYHEAD_BLEED_PX = 6;

const EDGES: readonly RulerEdge[] = ["start", "end"];
const EDGE_NAMES: Record<RulerEdge, string> = {
  start: "Selection start",
  end: "Selection end",
};

const px = (value: number) => `${value}px`;
const round3 = (value: number) => Number(value.toFixed(3));

export const Ruler = memo(function Ruler({
  start,
  pxPerSecond,
  width,
  duration,
  playhead,
  selection,
  sessions,
  readOnly = false,
  touch = false,
  label = "Timeline position",
  anchorProps,
  hitProps,
  onSeek,
  onFit,
  onScrubStart,
  onScrub,
  onScrubEnd,
  onSelectionDragStart,
  onSelectionDrag,
  onSelectionDragEnd,
  onSelectionNudge,
  onSelectionNudgeEnd,
}: RulerProps) {
  const root = useRef<HTMLDivElement>(null);
  const edgeOffset = useRef(0);
  const nudging = useRef<RulerEdge | null>(null);
  const [grabbed, setGrabbed] = useState<RulerGrip | null>(null);

  const windowEnd = start + width / pxPerSecond;
  const step = rulerStep(pxPerSecond, windowEnd);
  const ticks = rulerTicks(start, pxPerSecond, width, step, duration);
  const editable = !readOnly && selection !== undefined;

  const left = () => root.current?.getBoundingClientRect().left ?? 0;
  const secondsAt = (clientX: number) =>
    clamp(timeAtX(clientX - left(), start, pxPerSecond), 0, duration);

  const grab = useGrab<RulerGrip>({
    canGrab: (grip) => (grip === "scrub" ? true : editable),
    slop: (grip, event) =>
      grip === "scrub" && event.pointerType === "touch"
        ? TOUCH_SLOP_PX
        : HANDLE_DRAG_MIN_PX,
    onStart: (grip, pointer, press) => {
      if (grip === "scrub") {
        if (onScrubStart?.(secondsAt(pointer.clientX), pointer) === false) {
          return false;
        }
        setGrabbed(grip);
        return true;
      }
      if (onSelectionDragStart?.(grip, pointer) === false) return false;
      const edge = selection?.[grip] ?? 0;
      edgeOffset.current =
        press.clientX - (left() + xAtTime(edge, start, pxPerSecond));
      setGrabbed(grip);
      return true;
    },
    onMove: (grip, move) => {
      if (grip === "scrub") {
        onScrub?.(secondsAt(move.clientX), move);
        return;
      }
      onSelectionDrag?.(grip, {
        ...move,
        seconds: secondsAt(move.clientX - edgeOffset.current),
      });
    },
    onEnd: (grip, committed) => {
      setGrabbed(null);
      if (grip === "scrub") onScrubEnd?.(committed);
      else onSelectionDragEnd?.(grip, committed);
    },
  });

  const endNudge = useStableCallback(() => {
    const edge = nudging.current;
    nudging.current = null;
    if (edge) onSelectionNudgeEnd?.(edge);
  });
  useEffect(() => endNudge, [endNudge]);

  useEffect(() => {
    const grip = grab.active();
    if (grip && grip !== "scrub" && !editable) grab.abort();
  });

  const click = (event: MouseEvent<HTMLElement>) => {
    if (grab.consumeClick()) return;
    onSeek(secondsAt(event.clientX));
  };

  const focusStep = (from: "body" | RulerEdge, direction: -1 | 1) => {
    const order: readonly ("body" | RulerEdge)[] = editable
      ? ["body", "start", "end"]
      : ["body"];
    const next = order[order.indexOf(from) + direction];
    if (!next) return;
    root.current
      ?.querySelector<HTMLElement>(
        next === "body" ? ".sys-ruler-body" : `[data-edge="${next}"]`,
      )
      ?.focus();
  };
  const walkFocus = (
    event: KeyboardEvent<HTMLElement>,
    from: "body" | RulerEdge,
  ) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !editable ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    focusStep(from, event.key === "ArrowLeft" ? -1 : 1);
    return true;
  };

  const bodyKey = (event: KeyboardEvent<HTMLElement>) => {
    if (walkFocus(event, "body")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    let target: number | null = null;
    if (direction !== 0) {
      target =
        playhead + direction * step * (event.shiftKey ? SEEK_BIG_TICKS : 1);
    } else if (event.key === "Home") {
      target = 0;
    } else if (event.key === "End") {
      target = duration;
    }
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clamp(target, 0, duration);
    if (next !== playhead) onSeek(next);
  };

  const edgeKey = (edge: RulerEdge) => (event: KeyboardEvent<HTMLElement>) => {
    if (walkFocus(event, edge)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    nudging.current = edge;
    onSelectionNudge?.(
      edge,
      direction * (event.shiftKey ? SELECTION_NUDGE_BIG : SELECTION_NUDGE),
      { repeat: event.repeat },
    );
  };
  const edgeKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      nudging.current
    ) {
      event.stopPropagation();
      endNudge();
    }
  };

  const bodyHandlers = grab.handlers("scrub");

  const handle = (edge: RulerEdge) => {
    if (!selection) return null;
    const at = selection[edge];
    const x = xAtTime(at, start, pxPerSecond);
    if (x < -PLAYHEAD_BLEED_PX || x > width + PLAYHEAD_BLEED_PX) return null;
    const [min, max] =
      edge === "start"
        ? [0, Math.max(0, selection.end - RULER_MIN_SELECTION)]
        : [Math.min(duration, selection.start + RULER_MIN_SELECTION), duration];
    return (
      <span
        key={edge}
        className="sys-ruler-handle"
        data-edge={edge}
        data-dragging={grabbed === edge || undefined}
        role="slider"
        tabIndex={-1}
        aria-label={EDGE_NAMES[edge]}
        aria-orientation="horizontal"
        aria-valuemin={round3(min)}
        aria-valuemax={round3(max)}
        aria-valuenow={round3(at)}
        aria-valuetext={formatTime(at)}
        style={{ "--sys-ruler-x": px(x) } as CSSProperties}
        {...hitProps?.[edge]}
        onClick={click}
        onKeyDown={edgeKey(edge)}
        onKeyUp={edgeKeyUp}
        onBlur={endNudge}
        {...grab.handlers(edge)}
      >
        <span className="sys-ruler-grip" />
      </span>
    );
  };

  const playheadX = xAtTime(playhead, start, pxPerSecond);
  const selectionX = selection
    ? clamp(xAtTime(selection.start, start, pxPerSecond), 0, width)
    : 0;
  const selectionEnd = selection
    ? clamp(xAtTime(selection.end, start, pxPerSecond), 0, width)
    : 0;
  const selectionWidth = selection
    ? (selection.end - selection.start) * pxPerSecond
    : 0;

  return (
    <div
      ref={root}
      className="sys-ruler"
      role="group"
      aria-label="Time ruler"
      {...anchorProps}
      data-readonly={readOnly || undefined}
      data-touch={touch || undefined}
      data-scrubbing={grabbed === "scrub" || undefined}
      style={
        {
          "--sys-ruler-width": px(width),
          "--sys-ruler-sel": px(Math.max(0, selectionWidth)),
        } as CSSProperties
      }
    >
      <div className="sys-ruler-art" aria-hidden="true">
        {(sessions ?? []).map((session, index) => {
          const from = clamp(
            xAtTime(session.start, start, pxPerSecond),
            0,
            width,
          );
          const to = clamp(xAtTime(session.end, start, pxPerSecond), 0, width);
          if (to <= from) return null;
          return (
            <span
              key={`${session.start}-${session.end}`}
              className="sys-ruler-session"
              data-odd={index % 2 === 1 || undefined}
              style={
                {
                  "--sys-ruler-x": px(from),
                  "--sys-ruler-w": px(to - from),
                } as CSSProperties
              }
            >
              <span className="sys-ruler-pill">{session.label}</span>
            </span>
          );
        })}
        {ticks.map((tick) => (
          <span
            key={tick.time}
            className="sys-ruler-tick"
            style={{ "--sys-ruler-x": px(tick.x) } as CSSProperties}
          >
            {tick.label}
          </span>
        ))}
        {selection && selectionEnd > selectionX ? (
          <span
            className="sys-ruler-selection"
            style={
              {
                "--sys-ruler-x": px(selectionX),
                "--sys-ruler-w": px(selectionEnd - selectionX),
              } as CSSProperties
            }
          />
        ) : null}
        {playheadX >= -PLAYHEAD_BLEED_PX &&
        playheadX <= width + PLAYHEAD_BLEED_PX ? (
          <span
            className="sys-ruler-playhead"
            style={{ "--sys-ruler-x": px(playheadX) } as CSSProperties}
          />
        ) : null}
      </div>
      <div
        className="sys-ruler-body"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={round3(duration)}
        aria-valuenow={round3(clamp(playhead, 0, duration))}
        aria-valuetext={formatRulerTime(playhead, Math.min(step, 0.1))}
        {...hitProps?.scrub}
        onClick={click}
        onDoubleClick={onFit ? () => onFit() : undefined}
        onKeyDown={bodyKey}
        {...bodyHandlers}
      />
      {editable ? EDGES.map(handle) : null}
    </div>
  );
});
