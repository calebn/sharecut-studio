import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Menu, MenuItem } from "../ui";
import { clamp } from "../utils/math";
import { formatRulerTime, formatTime } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import { Marker, type MarkerAttrs } from "./Marker";
import {
  isRange,
  type LaneMarker,
  layoutMarkers,
  markerEnd,
  type PlacedMarker,
  type PlacedStack,
} from "./markerLayout";
import { ReadoutChip } from "./ReadoutChip";
import { timeAtX } from "./rulerMath";
import { SystemIcon } from "./SystemIcon";
import { type GrabMove, type GrabPointer, useGrab } from "./useGrab";

export type { LaneMarker } from "./markerLayout";

export type MarkerGrip = "move" | "start" | "end";

export type MarkerPointer = GrabPointer;

export type MarkerDrag = GrabMove & {
  /** Seconds the pointer has moved since the press, to add to the marker's time at the press. */
  delta: number;
  /** The time under the pointer, held to the episode. */
  seconds: number;
};

export type MarkerNudge = {
  /** The key is auto-repeating: the same press, held. */
  repeat: boolean;
};

/** A chapter being named: its flag is drawn at `at` with a field for the title. */
export type AddingChapter = { at: number };

export type MarkerLaneProps = {
  /** Every marker of the episode, in any order. Keep the array and its objects stable between renders. */
  markers: readonly LaneMarker[];
  /** Seconds at the lane's left edge. */
  start: number;
  pxPerSecond: number;
  /** The lane's width in px: the same three numbers the ruler is given. */
  width: number;
  /** The episode's length in seconds. Drags and nudges report times inside it. */
  duration: number;
  /** Ids of the selected markers. */
  selected?: readonly string[];
  /** A guest selects markers and reads their tips but cannot move or add them. */
  readOnly?: boolean;
  /** Edge and hit areas are 44 px; a coarse pointer does this by itself. */
  touch?: boolean;
  /** Names the lane's group. */
  label?: string;
  /** Show the inline name field of a chapter just added at this time. */
  adding?: AddingChapter | null;
  /** Attributes for the lane's root, such as a presence anchor. */
  anchorProps?: MarkerAttrs;
  /** Attributes for a marker's button (`move`) and for a bracket's edges, such as `data-hit-*`. Keep it stable. */
  hitProps?: (id: string, grip: MarkerGrip) => MarkerAttrs | undefined;
  /** A click or Enter. `additive` is Shift, Ctrl or Cmd. */
  onSelect: (id: string, additive: boolean) => void;
  /**
   * First movement of a drag on a chapter, a bracket or one of its edges,
   * never on a tap. Return `false` to refuse it.
   */
  onDragStart?: (
    id: string,
    grip: MarkerGrip,
    pointer: MarkerPointer,
  ) => boolean | undefined;
  onDrag?: (id: string, grip: MarkerGrip, drag: MarkerDrag) => void;
  /**
   * `committed` is false when Escape, a window blur, the browser, a lost
   * capture, or the marker leaving the lane ended it.
   */
  onDragEnd?: (id: string, grip: MarkerGrip, committed: boolean) => void;
  /**
   * Left or Right on a selected chapter or bracket, or on a bracket's edge:
   * move it `seconds` earlier (negative) or later. 0.1 s, Shift 1 s. A held
   * key calls this again with `repeat` set.
   */
  onNudge?: (
    id: string,
    grip: MarkerGrip,
    seconds: number,
    nudge: MarkerNudge,
  ) => void;
  /** The arrow was released, or focus left the marker: close the undo step. */
  onNudgeEnd?: (id: string, grip: MarkerGrip) => void;
  /** A double-click on an empty part of the lane: add a chapter at `seconds`. The host then passes `adding`. */
  onAdd?: (seconds: number) => void;
  /** Enter in the name field. */
  onAddCommit?: (seconds: number, title: string) => void;
  /** Escape in the name field, or leaving it empty. */
  onAddCancel?: () => void;
};

/** The shortest a bracket's edges let it get, in seconds. */
export const MARKER_MIN_SPAN = 0.1;
const NUDGE = 0.1;
const NUDGE_BIG = 1;

type Held = { id: string; grip: MarkerGrip };
type Dragged = Held & { x: number; from: number };

const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const round3 = (value: number) => Number(value.toFixed(3));
const fraction = (value: number, width: number) => value / Math.max(width, 1);

function timeText(marker: LaneMarker): string {
  const from = formatRulerTime(marker.start, 0.1);
  return isRange(marker)
    ? `${from} to ${formatRulerTime(markerEnd(marker), 0.1)}`
    : from;
}

function listName(marker: LaneMarker): string {
  switch (marker.kind) {
    case "chapter":
      return `Chapter ${marker.title}, ${timeText(marker)}`;
    case "comment":
      return `Comment by ${marker.author}, ${timeText(marker)}`;
    case "clip":
      return `Clip idea ${marker.title}, ${timeText(marker)}`;
  }
}

function signed(seconds: number): string {
  const sign = seconds < 0 ? "−" : "+";
  return `${sign}${Math.abs(seconds).toFixed(2)} s`;
}

const isFinger = (event: PointerEvent<HTMLElement>) =>
  event.pointerType === "touch" || event.pointerType === "pen";

type Routes = {
  press: (
    id: string,
    grip: MarkerGrip,
    event: PointerEvent<HTMLElement>,
  ) => void;
  click: (id: string, event: MouseEvent<HTMLElement>) => void;
  bodyKey: (id: string, event: KeyboardEvent<HTMLElement>) => void;
  edgeKey: (
    id: string,
    grip: MarkerGrip,
    event: KeyboardEvent<HTMLElement>,
  ) => void;
  keyUp: (event: KeyboardEvent<HTMLElement>) => void;
  endNudge: () => void;
};

type ItemProps = Routes & {
  placed: PlacedMarker;
  width: number;
  duration: number;
  selected: boolean;
  movable: boolean;
  dragging: MarkerGrip | null;
  hitProps: MarkerLaneProps["hitProps"];
};

const MarkerItem = memo(function MarkerItem({
  placed,
  width,
  duration,
  selected,
  movable,
  dragging,
  hitProps,
  press,
  click,
  bodyKey,
  edgeKey,
  keyUp,
  endNudge,
}: ItemProps) {
  const { marker } = placed;
  const id = marker.id;
  const at = fraction(placed.left, width);
  const to = fraction(
    marker.kind === "chapter" ? placed.titleEnd : placed.right,
    width,
  );
  const time = timeText(marker);
  const rootStyle = {
    "--sys-marker-reach-inline": `${px(-placed.reachStart)} ${px(-placed.reachEnd)}`,
  } as CSSProperties;
  const routes = (grip: MarkerGrip) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => press(id, grip, event),
  });
  const buttonProps = {
    ...hitProps?.(id, "move"),
    ...(movable ? { "data-movable": "true" } : {}),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => bodyKey(id, event),
    onKeyUp: keyUp,
    onBlur: endNudge,
    ...routes("move"),
  };
  const edge = (grip: "start" | "end") => {
    if (marker.kind !== "clip") return null;
    if (!(grip === "start" ? placed.startVisible : placed.endVisible)) {
      return null;
    }
    const [min, max, now] =
      grip === "start"
        ? [0, Math.max(0, marker.end - MARKER_MIN_SPAN), marker.start]
        : [
            Math.min(duration, marker.start + MARKER_MIN_SPAN),
            duration,
            marker.end,
          ];
    return (
      <span
        key={grip}
        className="sys-marker-edge"
        data-edge={grip}
        data-dragging={dragging === grip || undefined}
        role="slider"
        tabIndex={-1}
        aria-label={`${grip === "start" ? "Start" : "End"} of ${marker.title}`}
        aria-orientation="horizontal"
        aria-valuemin={round3(min)}
        aria-valuemax={round3(max)}
        aria-valuenow={round3(now)}
        aria-valuetext={formatTime(now)}
        {...hitProps?.(id, grip)}
        onClick={(event) => click(id, event)}
        onKeyDown={(event) => edgeKey(id, grip, event)}
        onKeyUp={keyUp}
        onBlur={endNudge}
        {...routes(grip)}
      >
        <span className="sys-marker-grip" />
      </span>
    );
  };
  const shared = {
    at,
    selected,
    dragging: dragging !== null,
    rootStyle,
    buttonProps,
    onSelect: (event: MouseEvent<HTMLButtonElement>) => click(id, event),
  };
  switch (marker.kind) {
    case "chapter":
      return (
        <Marker
          kind="chapter"
          title={marker.title}
          time={time}
          to={to}
          {...shared}
        />
      );
    case "comment":
      return (
        <Marker
          kind="comment"
          author={marker.author}
          time={time}
          to={isRange(marker) ? to : undefined}
          {...shared}
        />
      );
    case "clip":
      return (
        <Marker
          kind="clip"
          title={marker.title}
          time={time}
          to={to}
          proposed={marker.proposed ?? false}
          {...shared}
        >
          {movable ? (
            <>
              {edge("start")}
              {edge("end")}
            </>
          ) : null}
        </Marker>
      );
  }
});

const StackChip = memo(function StackChip({
  placed,
  width,
  selected,
  select,
}: {
  placed: PlacedStack;
  width: number;
  selected: boolean;
  select: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = placed.hidden.length;
  return (
    <span
      className="sys-marker"
      data-kind="stack"
      data-selected={selected || undefined}
      style={
        {
          "--sys-marker-at": fraction(placed.left, width),
          "--sys-marker-reach-inline": `${px(-placed.reachStart)} ${px(-placed.reachEnd)}`,
        } as CSSProperties
      }
    >
      <Menu
        open={open}
        onOpenChange={setOpen}
        label="Markers here"
        className="sys-marker-menu"
        trigger={({ onClick, ref, ...aria }) => (
          <button
            ref={ref}
            type="button"
            className="sys-marker-hit"
            aria-label={`${count} more ${count === 1 ? "marker" : "markers"}`}
            {...aria}
            onClick={onClick}
          >
            <span aria-hidden="true">+{count}</span>
          </button>
        )}
      >
        {placed.hidden.map((marker) => (
          <MenuItem
            key={marker.id}
            onSelect={() => {
              setOpen(false);
              select(marker.id);
            }}
          >
            {listName(marker)}
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
});

function AddField({
  at,
  left,
  onCommit,
  onCancel,
}: {
  at: number;
  left: number;
  onCommit: (seconds: number, title: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [title, setTitle] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => input.current?.focus(), []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    const name = title.trim();
    if (commit && name === "") {
      setEmpty(true);
      return;
    }
    done.current = true;
    if (commit) onCommit(at, name);
    else onCancel();
  };
  return (
    <span
      className="sys-marker-add"
      style={{ "--sys-marker-add-at": px(left) } as CSSProperties}
    >
      <SystemIcon name="flag" size={12} />
      <input
        ref={input}
        type="text"
        className="sys-marker-add-field"
        aria-label="Chapter name"
        aria-invalid={empty || undefined}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setEmpty(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
        }}
        onBlur={() => finish(title.trim() !== "")}
      />
    </span>
  );
}

export const MarkerLane = memo(function MarkerLane({
  markers,
  start,
  pxPerSecond,
  width,
  duration,
  selected,
  readOnly = false,
  touch = false,
  label = "Markers",
  adding = null,
  anchorProps,
  hitProps,
  onSelect,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
  onNudgeEnd,
  onAdd,
  onAddCommit,
  onAddCancel,
}: MarkerLaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const nudging = useRef<Held | null>(null);
  const [held, setHeld] = useState<Dragged | null>(null);

  const selectedIds = useMemo(() => new Set(selected ?? []), [selected]);
  const byId = useMemo(
    () => new Map(markers.map((marker) => [marker.id, marker])),
    [markers],
  );
  const pinned = held?.id;
  const items = useMemo(
    () => layoutMarkers(markers, start, pxPerSecond, width, pinned),
    [markers, start, pxPerSecond, width, pinned],
  );

  const left = () => root.current?.getBoundingClientRect().left ?? 0;
  const secondsAt = (clientX: number) =>
    clamp(timeAtX(clientX - left(), start, pxPerSecond), 0, duration);
  const movable = (id: string, grip: MarkerGrip = "move") => {
    const marker = byId.get(id);
    if (!marker || readOnly || marker.kind === "comment") return false;
    return grip === "move" || marker.kind === "clip";
  };
  const valueOf = (id: string, grip: MarkerGrip) => {
    const marker = byId.get(id);
    if (!marker) return 0;
    return grip === "end" ? markerEnd(marker) : marker.start;
  };

  const grab = useGrab<Held>({
    canGrab: ({ id, grip }, event) =>
      movable(id, grip) && (!isFinger(event) || selectedIds.has(id)),
    captureOnStart: () => track.current,
    onStart: ({ id, grip }, pointer) => {
      if (onDragStart?.(id, grip, pointer) === false) return false;
      setHeld({
        id,
        grip,
        x: pointer.clientX - left(),
        from: valueOf(id, grip),
      });
      return true;
    },
    onMove: ({ id, grip }, move) => {
      const x = move.clientX - left();
      setHeld((now) => (now ? { ...now, x } : now));
      onDrag?.(id, grip, {
        ...move,
        delta: move.dx / pxPerSecond,
        seconds: secondsAt(move.clientX),
      });
    },
    onEnd: ({ id, grip }, committed) => {
      setHeld(null);
      onDragEnd?.(id, grip, committed);
    },
  });

  useEffect(() => {
    const active = grab.active();
    if (active && !movable(active.id, active.grip)) grab.abort();
  });

  const endNudge = useStableCallback(() => {
    const now = nudging.current;
    nudging.current = null;
    if (now) onNudgeEnd?.(now.id, now.grip);
  });
  useEffect(() => endNudge, [endNudge]);

  const press = useStableCallback(
    (id: string, grip: MarkerGrip, event: PointerEvent<HTMLElement>) =>
      grab.press({ id, grip }, event),
  );
  const move = useStableCallback((event: PointerEvent<HTMLElement>) =>
    grab.move(event),
  );
  const up = useStableCallback((event: PointerEvent<HTMLElement>) =>
    grab.up(event),
  );
  const cancel = useStableCallback((event: PointerEvent<HTMLElement>) =>
    grab.cancel(event),
  );
  const click = useStableCallback(
    (id: string, event: MouseEvent<HTMLElement>) => {
      if (grab.consumeClick()) return;
      onSelect(id, event.shiftKey || event.ctrlKey || event.metaKey);
    },
  );
  const select = useStableCallback((id: string) => onSelect(id, false));

  const focusEdge = (
    from: HTMLElement,
    grip: MarkerGrip,
    direction: -1 | 1,
  ) => {
    const order: readonly MarkerGrip[] = ["move", "start", "end"];
    const next = order[order.indexOf(grip) + direction];
    if (!next) return;
    from
      .closest(".sys-marker")
      ?.querySelector<HTMLElement>(
        next === "move" ? ".sys-marker-hit" : `[data-edge="${next}"]`,
      )
      ?.focus();
  };
  const arrowOf = (event: KeyboardEvent<HTMLElement>) =>
    event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  const keys =
    (id: string, grip: MarkerGrip) => (event: KeyboardEvent<HTMLElement>) => {
      const direction = arrowOf(event);
      if (direction === 0 || event.ctrlKey || event.metaKey) return;
      const marker = byId.get(id);
      if (!marker || !movable(id, grip)) return;
      if (grip === "move" && !selectedIds.has(id)) return;
      if (event.altKey) {
        if (marker.kind !== "clip") return;
        event.preventDefault();
        event.stopPropagation();
        focusEdge(event.currentTarget, grip, direction);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      nudging.current = { id, grip };
      onNudge?.(id, grip, direction * (event.shiftKey ? NUDGE_BIG : NUDGE), {
        repeat: event.repeat,
      });
    };
  const bodyKey = useStableCallback(
    (id: string, event: KeyboardEvent<HTMLElement>) => keys(id, "move")(event),
  );
  const edgeKey = useStableCallback(
    (id: string, grip: MarkerGrip, event: KeyboardEvent<HTMLElement>) =>
      keys(id, grip)(event),
  );
  const keyUp = useStableCallback((event: KeyboardEvent<HTMLElement>) => {
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      nudging.current
    ) {
      event.stopPropagation();
      endNudge();
    }
  });

  const routes: Routes = {
    press,
    click,
    bodyKey,
    edgeKey,
    keyUp,
    endNudge,
  };

  const addAt = adding ? (adding.at - start) * pxPerSecond : 0;
  const heldMarker = held ? byId.get(held.id) : undefined;
  const heldValue = held ? valueOf(held.id, held.grip) : 0;

  return (
    <div
      ref={root}
      className="sys-markers"
      role="group"
      aria-label={label}
      {...anchorProps}
      data-readonly={readOnly || undefined}
      data-touch={touch || undefined}
      style={{ "--sys-markers-width": px(width) } as CSSProperties}
    >
      <div
        ref={track}
        className="sys-markers-track"
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget) cancel(event);
        }}
        onDoubleClick={(event) => {
          if (readOnly || !onAdd) return;
          if (
            event.target instanceof Element &&
            event.target.closest(".sys-marker, .sys-marker-add")
          ) {
            return;
          }
          onAdd(secondsAt(event.clientX));
        }}
      >
        {items.map((item) =>
          item.type === "stack" ? (
            <StackChip
              key={`stack-${item.hidden[0]?.id}`}
              placed={item}
              width={width}
              selected={item.hidden.some((marker) =>
                selectedIds.has(marker.id),
              )}
              select={select}
            />
          ) : (
            <MarkerItem
              key={item.marker.id}
              placed={item}
              width={width}
              duration={duration}
              selected={selectedIds.has(item.marker.id)}
              movable={movable(item.marker.id)}
              dragging={held?.id === item.marker.id ? held.grip : null}
              hitProps={hitProps}
              {...routes}
            />
          ),
        )}
        {adding && onAddCommit && onAddCancel ? (
          <AddField
            key={adding.at}
            at={adding.at}
            left={addAt}
            onCommit={onAddCommit}
            onCancel={onAddCancel}
          />
        ) : null}
      </div>
      {held && heldMarker ? (
        <ReadoutChip
          delta={signed(heldValue - held.from)}
          value={formatRulerTime(heldValue, 0.01)}
          at={{ x: held.x, y: 0 }}
        />
      ) : null}
    </div>
  );
});
