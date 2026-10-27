import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useId,
  useRef,
} from "react";
import { isHandleDrag } from "../edit/dragThreshold";
import { presenceColorVar } from "../presence/colors";
import { SystemIcon } from "./SystemIcon";
import type { TimeRange } from "./seconds";
import { capturePointer } from "./wavePointer";
import { PeakStrip } from "./waveStrip";

export type ClipHandle = "trim-in" | "trim-out" | "fade-in" | "fade-out";
export type ClipGrip = ClipHandle | "move";

/** The label needs this much room; a narrower clip says nothing, its button still has the name. */
export const CLIP_LABEL_MIN_WIDTH = 80;
/** Under this a clip has no room for fade knobs beside its trim zones. */
export const CLIP_NARROW_WIDTH = 48;
const NUDGE_MS = 10;
const NUDGE_BIG_MS = 100;

export type ClipDrag = {
  /** The pointer's client x. */
  x: number;
  /** Pixels from where the press began. */
  dx: number;
  /** Alt is held: the host moves in finer steps. */
  fine: boolean;
};

export type ClipProps = {
  /** Names the clip button and is the label on the clip: a take or source file. */
  name: string;
  /** Index into the eight presence colours; the track's. */
  colorIndex: number;
  /** Timeline seconds at the left edge. */
  start: number;
  /** Seconds the clip covers. The width is this times `pxPerSecond`. */
  duration: number;
  pxPerSecond: number;
  /** Fade lengths in milliseconds. */
  fadeIn?: number;
  fadeOut?: number;
  /** Source seconds still available past each edge, which bound the trim handles. */
  room?: { before: number; after: number };
  /** Peaks across the clip, 0 to 1. */
  peaks?: readonly number[];
  /** Muted spans, in seconds from the clip's start. */
  mutedRegions?: readonly TimeRange[];
  selected?: boolean;
  /** A guest sees and selects the clip but cannot move, trim or fade it. */
  readOnly?: boolean;
  /** Edge and fade hit areas are 44 px; a coarse pointer does this by itself. */
  touch?: boolean;
  /** The grip a drag has hold of, so the clip shows it in use. */
  dragging?: ClipGrip | null;
  /** A click or Enter; `extend` is Shift or Ctrl held, which adds to the selection. */
  onSelect: (extend: boolean) => void;
  /** First movement of a drag on the body or a handle, never on a tap. */
  onDragStart?: (grip: ClipGrip) => void;
  onDrag?: (grip: ClipGrip, drag: ClipDrag) => void;
  /** `committed` is false when Escape, the browser or a lost capture ended it. */
  onDragEnd?: (grip: ClipGrip, committed: boolean) => void;
  /**
   * An arrow key on a focused handle: Left and Right move the handle's edge
   * earlier or later in time by 10 ms, Shift 100 ms. For a fade-in later is
   * longer, for a fade-out later is shorter.
   */
  onNudge?: (handle: ClipHandle, ms: number) => void;
  /** For a host that walks focus among clips, as lane keys do. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

type Grab = {
  grip: ClipGrip;
  pointerId: number;
  fromX: number;
  moved: boolean;
};

const HANDLE_NAMES: Record<ClipHandle, string> = {
  "trim-in": "Trim start",
  "trim-out": "Trim end",
  "fade-in": "Fade in",
  "fade-out": "Fade out",
};

const px = (value: number) => `${value}px`;

export function Clip({
  name,
  colorIndex,
  start,
  duration,
  pxPerSecond,
  fadeIn = 0,
  fadeOut = 0,
  room = { before: 0, after: 0 },
  peaks,
  mutedRegions = [],
  selected = false,
  readOnly = false,
  touch = false,
  dragging = null,
  onSelect,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
  onKeyDown,
}: ClipProps) {
  const grab = useRef<Grab | null>(null);
  const dragged = useRef(false);
  const mutedId = useId();
  const width = duration * pxPerSecond;
  const fadeInPx = (fadeIn / 1000) * pxPerSecond;
  const fadeOutPx = (fadeOut / 1000) * pxPerSecond;
  const narrow = width < CLIP_NARROW_WIDTH;
  const end = start + duration;

  const down = (grip: ClipGrip) => (event: PointerEvent<HTMLElement>) => {
    if (readOnly || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    dragged.current = false;
    grab.current = {
      grip,
      pointerId: event.pointerId,
      fromX: event.clientX,
      moved: false,
    };
    capturePointer(event);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.moved) {
      if (!isHandleDrag(held.fromX, event.clientX)) return;
      held.moved = true;
      onDragStart?.(held.grip);
    }
    onDrag?.(held.grip, {
      x: event.clientX,
      dx: event.clientX - held.fromX,
      fine: event.altKey,
    });
  };
  const finish = (committed: boolean) => (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    if (!held.moved) return;
    dragged.current = held.grip === "move";
    onDragEnd?.(held.grip, committed);
  };
  const cancelByKey = (event: KeyboardEvent<HTMLElement>) => {
    const held = grab.current;
    if (event.key !== "Escape" || !held?.moved) return false;
    event.preventDefault();
    event.stopPropagation();
    grab.current = null;
    dragged.current = held.grip === "move";
    onDragEnd?.(held.grip, false);
    return true;
  };
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onSelect(event.shiftKey || event.ctrlKey || event.metaKey);
  };
  const bodyKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!cancelByKey(event)) onKeyDown?.(event);
  };
  const handleKey =
    (handle: ClipHandle) => (event: KeyboardEvent<HTMLElement>) => {
      if (cancelByKey(event)) return;
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      onNudge?.(handle, direction * (event.shiftKey ? NUDGE_BIG_MS : NUDGE_MS));
    };

  const pointerHandlers = (grip: ClipGrip) => ({
    onPointerDown: down(grip),
    onPointerMove: move,
    onPointerUp: finish(true),
    onPointerCancel: finish(false),
    onLostPointerCapture: finish(false),
  });

  const handle = (kind: ClipHandle) => {
    const fade = kind.startsWith("fade");
    const value = fade
      ? kind === "fade-in"
        ? fadeIn
        : fadeOut
      : kind === "trim-in"
        ? start
        : end;
    const [min, max] = fade
      ? [0, duration * 1000]
      : kind === "trim-in"
        ? [start - room.before, end]
        : [start, end + room.after];
    const unit = fade ? "ms" : "s";
    return (
      <span
        key={kind}
        className="sys-clip-handle"
        data-handle={kind}
        data-dragging={dragging === kind || undefined}
        role="slider"
        tabIndex={selected ? 0 : -1}
        aria-label={`${HANDLE_NAMES[kind]} of ${name}`}
        aria-orientation="horizontal"
        aria-valuemin={Number(min.toFixed(3))}
        aria-valuemax={Number(max.toFixed(3))}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={`${Number(value.toFixed(3))} ${unit}`}
        onKeyDown={handleKey(kind)}
        {...pointerHandlers(kind)}
      >
        <span className="sys-clip-grip" />
      </span>
    );
  };

  return (
    <div
      className="sys-clip"
      data-selected={selected || undefined}
      data-readonly={readOnly || undefined}
      data-narrow={narrow || undefined}
      data-touch={touch || undefined}
      data-dragging={dragging || undefined}
      style={
        {
          "--sys-clip-color": presenceColorVar(colorIndex),
          "--sys-clip-width": px(width),
          "--sys-clip-fade-in": px(fadeInPx),
          "--sys-clip-fade-out": px(fadeOutPx),
        } as CSSProperties
      }
    >
      <span className="sys-clip-art" aria-hidden="true">
        {peaks && peaks.length > 0 ? (
          <span className="sys-clip-peaks">
            <PeakStrip peaks={peaks} />
          </span>
        ) : null}
        {fadeInPx > 0 ? (
          <svg
            className="sys-clip-fade"
            data-edge="in"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            focusable="false"
          >
            <polygon points="0,0 1,0 0,1" />
            <line x1="0" y1="1" x2="1" y2="0" />
          </svg>
        ) : null}
        {fadeOutPx > 0 ? (
          <svg
            className="sys-clip-fade"
            data-edge="out"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            focusable="false"
          >
            <polygon points="0,0 1,0 1,1" />
            <line x1="0" y1="0" x2="1" y2="1" />
          </svg>
        ) : null}
        {mutedRegions.map((region) => (
          <span
            key={`${region.start}-${region.end}`}
            className="sys-clip-muted"
            style={
              {
                insetInlineStart: px(region.start * pxPerSecond),
                inlineSize: px((region.end - region.start) * pxPerSecond),
              } as CSSProperties
            }
          >
            <SystemIcon name="volume-x" size={12} />
          </span>
        ))}
      </span>
      <button
        type="button"
        className="sys-clip-body"
        aria-label={name}
        aria-pressed={selected}
        aria-describedby={mutedRegions.length > 0 ? mutedId : undefined}
        data-movable={!readOnly || undefined}
        onClick={click}
        onKeyDown={bodyKey}
        {...pointerHandlers("move")}
      />
      {mutedRegions.length > 0 ? (
        <span id={mutedId} className="sr-only">
          Part of this clip is muted
        </span>
      ) : null}
      {width >= CLIP_LABEL_MIN_WIDTH ? (
        <span className="sys-clip-label" aria-hidden="true">
          {name}
        </span>
      ) : null}
      {readOnly ? null : (
        <>
          {handle("trim-in")}
          {handle("trim-out")}
          {narrow ? null : handle("fade-in")}
          {narrow ? null : handle("fade-out")}
        </>
      )}
    </div>
  );
}
