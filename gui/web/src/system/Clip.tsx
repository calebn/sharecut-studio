import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { presenceColorVar } from "../presence/colors";
import { formatTime } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import { SystemIcon } from "./SystemIcon";
import type { TimeRange } from "./seconds";
import { capturePointer } from "./wavePointer";
import { PeakStrip } from "./waveStrip";

export type ClipHandle = "trim-in" | "trim-out" | "fade-in" | "fade-out";
export type ClipGrip = ClipHandle | "move";

/** The label shows on a clip wider than this; a narrower clip is still named for assistive tech. */
export const CLIP_LABEL_MIN_WIDTH = 80;
/** Under this a clip has no room for fade knobs beside its trim zones. */
export const CLIP_NARROW_WIDTH = 48;
/**
 * Under a coarse pointer a clip needs both 44 px trim zones and a 44 px knob
 * on each side of its middle for the fade knobs to be separate targets. A
 * narrower clip keeps its fades for the keyboard and drops their touch area.
 */
export const CLIP_TOUCH_FADE_MIN_WIDTH = 176;
/** The shortest a trim handle lets a clip get, in seconds. */
export const CLIP_MIN_DURATION = 0.05;
const NUDGE_MS = 10;
const NUDGE_BIG_MS = 100;

/** `data-*` attributes (a hit target, a presence anchor) the host wants on the clip's elements. */
export type ClipAttrs = Readonly<Record<string, string>>;

export type ClipModifiers = {
  /** Shift is held. */
  shift: boolean;
  /** Ctrl or Cmd is held. */
  mod: boolean;
};

/** Where the pointer is and which keys are down; the host reads lane, snapping and time lock from it. */
export type ClipPointer = {
  clientX: number;
  clientY: number;
  /** Shift locks time: the move changes lane only. */
  shift: boolean;
  /** Alt turns snapping off. */
  alt: boolean;
};

export type ClipDrag = ClipPointer & {
  /** Pixels from where the press began. */
  dx: number;
  dy: number;
};

export type ClipNudge = {
  /** The key is auto-repeating: the same press, held. */
  repeat: boolean;
};

export type ClipProps = {
  /** The clip's id, first argument of every callback so one function serves every clip. */
  id: string;
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
  /** Peaks across the clip, 0 to 1. The clip draws at most one bar per pixel of its width. */
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
  /**
   * The clip as the destination of a move: the same look with no button, no
   * handles and no hit area, and hidden from assistive tech.
   */
  ghost?: boolean;
  /** The body's tab stop. A lane that walks focus itself passes -1 for all but one clip. */
  tabIndex?: 0 | -1;
  /** The body button, so a lane can move focus to this clip. */
  bodyRef?: Ref<HTMLButtonElement>;
  /** Attributes for the body (`move`) and for each handle, such as `data-hit-*`. */
  hitProps?: Partial<Record<ClipGrip, ClipAttrs>>;
  /** Attributes for the clip's root, such as a presence anchor. */
  anchorProps?: ClipAttrs;
  /** A click or Enter. */
  onSelect: (id: string, modifiers: ClipModifiers) => void;
  /**
   * First movement of a drag on the body or a handle, never on a tap. Return
   * `false` to refuse it: the clip drops the press and reports nothing more.
   */
  onDragStart?: (
    id: string,
    grip: ClipGrip,
    pointer: ClipPointer,
  ) => boolean | undefined;
  onDrag?: (id: string, grip: ClipGrip, drag: ClipDrag) => void;
  /**
   * `committed` is false when Escape, a window blur, the browser, a lost
   * capture or the clip leaving the page ended it.
   */
  onDragEnd?: (id: string, grip: ClipGrip, committed: boolean) => void;
  /**
   * An arrow key on a focused handle: Left and Right move the handle's edge
   * earlier or later in time by `ms` (10 ms, Shift 100 ms; negative is
   * earlier). For a fade-in later is longer, for a fade-out later is shorter.
   * A held key calls this again with `repeat` set.
   */
  onNudge?: (
    id: string,
    handle: ClipHandle,
    ms: number,
    nudge: ClipNudge,
  ) => void;
  /** The arrow was released, or focus left the handle: close the undo step. */
  onNudgeEnd?: (id: string, handle: ClipHandle) => void;
  /** Up or Down on the body or a handle: focus the clip above or below on the next lane. */
  onLaneStep?: (id: string, direction: -1 | 1) => void;
  /** Every other key on the body, for a host that walks focus among clips. */
  onKeyDown?: (id: string, event: KeyboardEvent<HTMLButtonElement>) => void;
};

type Grab = {
  grip: ClipGrip;
  pointerId: number;
  fromX: number;
  fromY: number;
  moved: boolean;
};

const HANDLE_NAMES: Record<ClipHandle, string> = {
  "trim-in": "Trim start",
  "trim-out": "Trim end",
  "fade-in": "Fade in",
  "fade-out": "Fade out",
};

/** Focus order inside a selected clip, the way the handles sit left to right. */
const FOCUS_ORDER: readonly (ClipHandle | "body")[] = [
  "body",
  "trim-in",
  "fade-in",
  "fade-out",
  "trim-out",
];

const px = (value: number) => `${value}px`;
const round3 = (value: number) => Number(value.toFixed(3));

function pointerOf(
  event: PointerEvent<HTMLElement> | globalThis.PointerEvent,
): ClipPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

export const Clip = memo(function Clip({
  id,
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
  ghost = false,
  tabIndex = 0,
  bodyRef,
  hitProps,
  anchorProps,
  onSelect,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
  onNudgeEnd,
  onLaneStep,
  onKeyDown,
}: ClipProps) {
  const root = useRef<HTMLDivElement>(null);
  const grab = useRef<Grab | null>(null);
  const dragged = useRef(false);
  const nudging = useRef<ClipHandle | null>(null);
  const mutedId = useId();
  const width = duration * pxPerSecond;
  const fadeInPx = (fadeIn / 1000) * pxPerSecond;
  const fadeOutPx = (fadeOut / 1000) * pxPerSecond;
  const narrow = width < CLIP_NARROW_WIDTH;
  const end = start + duration;
  const durationMs = duration * 1000;
  const editable = !readOnly && !ghost;
  const bars = useMemo(() => Math.max(1, Math.round(width)), [width]);

  const stopWatching = useStableCallback(() => {
    document.removeEventListener("keydown", escapeDrag, true);
    window.removeEventListener("blur", abort);
  });
  const abort = useStableCallback(() => {
    const held = grab.current;
    stopWatching();
    if (!held) return;
    grab.current = null;
    if (!held.moved) return;
    dragged.current = held.grip === "move";
    onDragEnd?.(id, held.grip, false);
  });
  const escapeDrag = useStableCallback((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || !grab.current?.moved) return;
    event.preventDefault();
    event.stopPropagation();
    abort();
  });
  const endNudge = useStableCallback(() => {
    const handle = nudging.current;
    nudging.current = null;
    if (handle) onNudgeEnd?.(id, handle);
  });

  useEffect(
    () => () => {
      abort();
      endNudge();
    },
    [abort, endNudge],
  );

  useEffect(() => {
    const grip = grab.current?.grip;
    if (!grip) return;
    const mounted =
      grip === "move"
        ? !ghost
        : editable && (!narrow || grip.startsWith("trim"));
    if (!mounted) abort();
  }, [abort, editable, ghost, narrow]);

  const down = (grip: ClipGrip) => (event: PointerEvent<HTMLElement>) => {
    if (!editable) return;
    const finger = event.pointerType === "touch" || event.pointerType === "pen";
    if (
      finger ? !selected : event.pointerType === "mouse" && event.button !== 0
    ) {
      return;
    }
    if (grab.current && grab.current.pointerId !== event.pointerId) return;
    dragged.current = false;
    grab.current = {
      grip,
      pointerId: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
    };
    document.addEventListener("keydown", escapeDrag, true);
    window.addEventListener("blur", abort);
    capturePointer(event);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    const dx = event.clientX - held.fromX;
    const dy = event.clientY - held.fromY;
    if (!held.moved) {
      const far =
        held.grip === "move"
          ? Math.hypot(dx, dy) >= HANDLE_DRAG_MIN_PX
          : Math.abs(dx) >= HANDLE_DRAG_MIN_PX;
      if (!far) return;
      held.moved = true;
      if (onDragStart?.(id, held.grip, pointerOf(event)) === false) {
        grab.current = null;
        stopWatching();
        dragged.current = false;
        return;
      }
    }
    onDrag?.(id, held.grip, { ...pointerOf(event), dx, dy });
  };
  const finish = (committed: boolean) => (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    stopWatching();
    if (!held.moved) return;
    dragged.current = held.grip === "move";
    onDragEnd?.(id, held.grip, committed);
  };
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onSelect(id, {
      shift: event.shiftKey,
      mod: event.ctrlKey || event.metaKey,
    });
  };

  const focusStep = (from: ClipHandle | "body", direction: -1 | 1) => {
    const order = FOCUS_ORDER.filter(
      (part) => !narrow || part === "body" || part.startsWith("trim"),
    );
    const next = order[order.indexOf(from) + direction];
    if (!next) return;
    root.current
      ?.querySelector<HTMLElement>(
        next === "body" ? ".sys-clip-body" : `[data-handle="${next}"]`,
      )
      ?.focus();
  };
  const laneStep = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return false;
    }
    const direction =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (direction === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    onLaneStep?.(id, direction);
    return true;
  };
  const focusKey = (
    event: KeyboardEvent<HTMLElement>,
    from: ClipHandle | "body",
  ) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    focusStep(from, event.key === "ArrowLeft" ? -1 : 1);
    return true;
  };
  const bodyKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (selected && editable && focusKey(event, "body")) return;
    if (laneStep(event)) return;
    onKeyDown?.(id, event);
  };
  const handleKey =
    (handle: ClipHandle) => (event: KeyboardEvent<HTMLElement>) => {
      if (focusKey(event, handle) || laneStep(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      event.stopPropagation();
      nudging.current = handle;
      onNudge?.(
        id,
        handle,
        direction * (event.shiftKey ? NUDGE_BIG_MS : NUDGE_MS),
        { repeat: event.repeat },
      );
    };
  const handleKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      nudging.current
    ) {
      event.stopPropagation();
      endNudge();
    }
  };

  const pointerHandlers = (grip: ClipGrip) => ({
    onPointerDown: down(grip),
    onPointerMove: move,
    onPointerUp: finish(true),
    onPointerCancel: finish(false),
    onLostPointerCapture: finish(false),
  });

  const handle = (kind: ClipHandle) => {
    const [now, min, max, text] =
      kind === "fade-in"
        ? [fadeIn, 0, Math.max(0, durationMs - fadeOut), `${round3(fadeIn)} ms`]
        : kind === "fade-out"
          ? [
              durationMs - fadeOut,
              Math.min(fadeIn, durationMs),
              durationMs,
              `${round3(fadeOut)} ms`,
            ]
          : kind === "trim-in"
            ? [
                start,
                start - room.before,
                Math.max(start, end - CLIP_MIN_DURATION),
                formatTime(start),
              ]
            : [
                end,
                Math.min(end, start + CLIP_MIN_DURATION),
                end + room.after,
                formatTime(end),
              ];
    return (
      <span
        key={kind}
        className="sys-clip-handle"
        data-handle={kind}
        data-dragging={dragging === kind || undefined}
        role="slider"
        tabIndex={-1}
        aria-label={`${HANDLE_NAMES[kind]} of ${name}`}
        aria-orientation="horizontal"
        aria-valuemin={round3(min)}
        aria-valuemax={round3(max)}
        aria-valuenow={round3(now)}
        aria-valuetext={text}
        {...hitProps?.[kind]}
        onKeyDown={handleKey(kind)}
        onKeyUp={handleKeyUp}
        onBlur={endNudge}
        {...pointerHandlers(kind)}
      >
        <span className="sys-clip-grip" />
      </span>
    );
  };

  return (
    <div
      ref={root}
      className="sys-clip"
      data-clip-id={id}
      {...anchorProps}
      data-selected={selected || undefined}
      data-readonly={readOnly || undefined}
      data-narrow={narrow || undefined}
      data-compact={width < CLIP_TOUCH_FADE_MIN_WIDTH || undefined}
      data-touch={touch || undefined}
      data-ghost={ghost || undefined}
      data-dragging={dragging || undefined}
      aria-hidden={ghost || undefined}
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
            <PeakStrip peaks={peaks} maxBars={bars} />
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
      {ghost ? null : (
        <button
          ref={bodyRef}
          type="button"
          className="sys-clip-body"
          tabIndex={tabIndex}
          aria-label={name}
          aria-pressed={selected}
          aria-describedby={mutedRegions.length > 0 ? mutedId : undefined}
          data-movable={editable || undefined}
          {...hitProps?.move}
          onClick={click}
          onKeyDown={bodyKey}
          {...pointerHandlers("move")}
        />
      )}
      {mutedRegions.length > 0 && !ghost ? (
        <span id={mutedId} className="sr-only">
          Part of this clip is muted
        </span>
      ) : null}
      {width > CLIP_LABEL_MIN_WIDTH ? (
        <span className="sys-clip-label" aria-hidden="true">
          {name}
        </span>
      ) : null}
      {editable ? (
        <>
          {handle("trim-in")}
          {narrow ? null : handle("fade-in")}
          {narrow ? null : handle("fade-out")}
          {handle("trim-out")}
        </>
      ) : null}
    </div>
  );
});
