import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HANDLE_DRAG_MIN_PX, TOUCH_SLOP_PX } from "../hooks/gestureConstants";
import { clamp } from "../utils/math";
import { formatRulerTime, formatTime } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import { edgeBounds, within } from "./dragBounds";
import type { MarkerAttrs } from "./Marker";
import {
  DEFAULT_REM_PX,
  PLAYHEAD_BLEED_PX,
  round3,
  rulerStep,
  rulerTicks,
  timeAtX,
  xAtTime,
} from "./rulerMath";
import type { TimeRange } from "./seconds";
import {
  type GrabMove,
  type GrabPointer,
  swallowsDuringDrag,
  useGrab,
} from "./useGrab";

export type RulerEdge = "start" | "end";
type RulerGrip = "scrub" | RulerEdge;

export type RulerSession = TimeRange & { label: string };

type RulerDrag = GrabMove & {
  /** Where the edge would sit under the pointer, held to the episode. */
  seconds: number;
};

type RulerNudge = { repeat: boolean };

export type RulerProps = {
  start: number;
  pxPerSecond: number;
  /** In px. The marker lane takes the same `start`, `pxPerSecond` and `width`. */
  width: number;
  duration: number;
  playhead: number;
  /** A host that draws the needle itself (a fixed line, or a moving one that must not re-render the ruler) hides this one. The value, the keys and the labels still follow `playhead`. */
  hidePlayhead?: boolean;
  selection?: TimeRange;
  /** Drawn as alternating bands behind the ticks. */
  sessions?: readonly RulerSession[];
  /** A guest seeks and scrubs but sees no selection handles. */
  readOnly?: boolean;
  /** 44 px selection handles; a coarse pointer does this by itself. */
  touch?: boolean;
  label?: string;
  anchorProps?: MarkerAttrs;
  /** Attributes for the body (`scrub`) and for each selection handle, such as `data-hit-*`. */
  hitProps?: Partial<Record<RulerGrip, MarkerAttrs>>;
  onSeek: (seconds: number) => void;
  /** A double-click. */
  onFit?: () => void;
  /** First movement of a scrub, never a tap. Return `false` to refuse it. */
  onScrubStart?: (seconds: number, pointer: GrabPointer) => boolean | undefined;
  onScrub?: (seconds: number, pointer: GrabPointer) => void;
  /** `committed` is false when Escape, a blur, the browser, a lost capture or unmounting ended it: the host restores the playhead. */
  onScrubEnd?: (committed: boolean) => void;
  /** Return `false` to refuse the drag. */
  onSelectionDragStart?: (
    edge: RulerEdge,
    pointer: GrabPointer,
  ) => boolean | undefined;
  onSelectionDrag?: (edge: RulerEdge, drag: RulerDrag) => void;
  onSelectionDragEnd?: (edge: RulerEdge, committed: boolean) => void;
  /** 10 ms per press, Shift 100 ms; a held key calls again with `repeat` set. */
  onSelectionNudge?: (
    edge: RulerEdge,
    seconds: number,
    nudge: RulerNudge,
  ) => void;
  /** The arrow was released or focus left: close the undo step. */
  onSelectionNudgeEnd?: (edge: RulerEdge) => void;
};

export const RULER_MIN_SELECTION = 0.01;
const SELECTION_NUDGE = 0.01;
const SELECTION_NUDGE_BIG = 0.1;
const SEEK_BIG_TICKS = 10;

const EDGES: readonly RulerEdge[] = ["start", "end"];
const EDGE_NAMES: Record<RulerEdge, string> = {
  start: "Selection start",
  end: "Selection end",
};

const px = (value: number) => `${value}px`;

const onResize = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};

/** The root font size in px: the labels' room is figured in rem, so a larger text setting spaces them wider. */
function rootFontPx(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return size > 0 ? size : DEFAULT_REM_PX;
}

export const Ruler = memo(function Ruler({
  start,
  pxPerSecond,
  width,
  duration,
  playhead,
  hidePlayhead = false,
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

  const rem = useSyncExternalStore(onResize, rootFontPx, () => DEFAULT_REM_PX);
  const windowEnd = start + width / pxPerSecond;
  const step = rulerStep(pxPerSecond, windowEnd, rem);
  const ticks = rulerTicks(start, pxPerSecond, width, step, duration, rem);
  const editable = !readOnly && selection !== undefined;

  const left = () => root.current?.getBoundingClientRect().left ?? 0;
  const secondsAt = (clientX: number) =>
    clamp(timeAtX(clientX - left(), start, pxPerSecond), 0, duration);

  const grab = useGrab<RulerGrip>({
    // A finger on the body only taps: a horizontal swipe belongs to the browser, which pans the timeline.
    canGrab: (grip, event) =>
      grip === "scrub" ? event.pointerType !== "touch" : editable,
    slop: (grip, event) =>
      grip !== "scrub" &&
      (event.pointerType === "touch" || event.pointerType === "pen")
        ? TOUCH_SLOP_PX
        : HANDLE_DRAG_MIN_PX,
    captureOnStart: () => root.current,
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
      const seconds = secondsAt(move.clientX - edgeOffset.current);
      onSelectionDrag?.(grip, {
        ...move,
        seconds: selection
          ? within(
              edgeBounds(grip, selection, duration, RULER_MIN_SELECTION),
              seconds,
            )
          : seconds,
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
    if (grab.consumeClick(event)) return;
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

  const swallowedMidDrag = (event: KeyboardEvent<HTMLElement>) => {
    if (!grab.dragging() || !swallowsDuringDrag(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const bodyKey = (event: KeyboardEvent<HTMLElement>) => {
    if (walkFocus(event, "body")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (swallowedMidDrag(event)) return;
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
    if (swallowedMidDrag(event)) return;
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

  const handle = (edge: RulerEdge) => {
    if (!selection) return null;
    const at = selection[edge];
    const x = xAtTime(at, start, pxPerSecond);
    if (x < -PLAYHEAD_BLEED_PX || x > width + PLAYHEAD_BLEED_PX) return null;
    const bounds = edgeBounds(edge, selection, duration, RULER_MIN_SELECTION);
    const [min, max] = bounds;
    const now = within(bounds, at);
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
        aria-valuenow={round3(now)}
        aria-valuetext={formatTime(now)}
        style={{ "--sys-ruler-x": px(x) } as CSSProperties}
        {...hitProps?.[edge]}
        onClick={click}
        onKeyDown={edgeKey(edge)}
        onKeyUp={edgeKeyUp}
        onBlur={endNudge}
        onPointerDown={(event) => grab.press(edge, event)}
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
      onPointerMove={grab.move}
      onPointerUp={grab.up}
      onPointerCancel={grab.cancel}
      onLostPointerCapture={(event) => {
        if (event.target === event.currentTarget) grab.cancel(event);
      }}
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
            data-align={tick.align === "end" ? "end" : undefined}
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
        {!hidePlayhead &&
        playheadX >= -PLAYHEAD_BLEED_PX &&
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
        aria-valuetext={formatRulerTime(
          clamp(playhead, 0, duration),
          Math.min(step, 0.1),
        )}
        {...hitProps?.scrub}
        onClick={click}
        onDoubleClick={onFit ? () => onFit() : undefined}
        onKeyDown={bodyKey}
        onPointerDown={(event) => grab.press("scrub", event)}
      />
      {editable ? EDGES.map(handle) : null}
    </div>
  );
});
