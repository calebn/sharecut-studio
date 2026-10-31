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
import { presenceColorVar } from "../presence/colors";
import { clamp } from "../utils/math";
import { useStableCallback } from "../utils/useStableCallback";
import { type Bounds, boundedDelta, within } from "./dragBounds";
import {
  clampDb,
  dbAfterDrag,
  dbToY,
  ENVELOPE_FLOOR_DB,
  ENVELOPE_POINT_GAP_SEC,
  ENVELOPE_TOP_DB,
  type EnvelopePointData,
  formatDb,
  hitRadius,
  levelStep,
  linePath,
  nearestGapPx,
  pointBounds,
  pointVisible,
  pointY,
  readoutText,
  round2,
  roundDb,
  sortPoints,
  spokenTime,
  timeStep,
  valueText,
  yToDb,
} from "./envelopeMath";
import { clampLaneHeight } from "./laneMath";
import type { MarkerAttrs } from "./Marker";
import { ReadoutChip } from "./ReadoutChip";
import { round3, timeAtX, xAtTime } from "./rulerMath";
import { type GrabPointer, useGrab } from "./useGrab";

export type { EnvelopePointData } from "./envelopeMath";

/**
 * What changed on a point. A time nudge carries `timeSeconds`, a level nudge
 * `db`. A drag locks to the axis the pointer first moved along (the larger of
 * |dx| and |dy|, once it is 3 px away from where the drag started) and carries
 * only that axis, on every move, including back at its start value: a host
 * may merge (`change.timeSeconds ?? point.time`) or replace. The other axis
 * is never sent, so a time drag cannot touch the level and the reverse. A
 * value that is not changed is never rounded: the start value comes back
 * exactly.
 */
export type EnvelopeChange = { timeSeconds?: number; db?: number };

/** Attributes the host may set on the leaf's hit targets: `data-hit-*` strings only, nothing else is spread. */
export type HitAttrs = Readonly<Record<`data-hit-${string}`, string>>;

export type EnvelopeHitProps = {
  /** Called in each point's render with its id, time, level and selected state; keep it pure and stable (`useCallback`), as a new function re-renders every point. */
  point?: (
    id: string,
    time: number,
    db: number,
    selected: boolean,
  ) => HitAttrs | undefined;
  /** On the strip along the line (the band), for the one that adds a point. */
  line?: HitAttrs;
};

export type EnvelopeProps = {
  /** Keep the array and its objects stable between renders. */
  points: readonly EnvelopePointData[];
  /** The track's name; the envelope is a group named `Volume envelope, ${trackName}`. */
  trackName: string;
  /** Index into the eight presence colours; the track's. */
  colorIndex: number;
  /** Seconds at the left edge. The ruler, the marker lane and the lane take the same `start`, `pxPerSecond` and `width`. */
  start: number;
  pxPerSecond: number;
  /** In px: the visible window, not the whole canvas. The line is clipped to it, so every point may be passed. */
  width: number;
  /** In px, held to 72 through 240: the lane's own height. */
  height?: number;
  /** In px from the top of the positioned parent. Inside a `Lane` it is 0. */
  top?: number;
  /** Episode length in seconds; points stay inside it. 0, the default, leaves the end open. */
  duration?: number;
  /** The selected point's id. */
  selected?: string | null;
  /** Shown from the track's More menu: draws the unity line when there are no points. With points it is always shown. */
  visible?: boolean;
  /** A guest selects points and reads them but cannot add, move or remove them. */
  readOnly?: boolean;
  /** 44 px point hit areas and a 24 px band along the line; a coarse pointer does this by itself. */
  touch?: boolean;
  anchorProps?: MarkerAttrs;
  /** Plain `data-hit-*` attributes for the host's hit routing: on each point and on the line's band. Absent, the DOM is the same as without it. */
  hitProps?: EnvelopeHitProps;
  onSelect: (id: string) => void;
  /** A click on the line, not on a point. The one callback without an id: the point is new. */
  onAdd?: (timeSeconds: number, db: number) => void;
  onRemove?: (id: string) => void;
  /**
   * A drag calls it on each move and a nudge on each press; the host keeps the
   * point where it says. The envelope holds no nudge state: each press steps
   * from the `points` it has now, so the host must fold every call into the
   * `points` it passes back (a preview), commit once at `onNudgeEnd`, and drop
   * the preview if the commit is refused. Without that feedback every press
   * repeats the first step. While dragging the envelope draws the held point
   * itself; the host may fold the same calls in, replacing the point's axis
   * (never adding to it).
   */
  onMove?: (id: string, change: EnvelopeChange) => void;
  /** First movement of a drag, never a tap. Return `false` to refuse it. */
  onDragStart?: (id: string, pointer: GrabPointer) => boolean | undefined;
  /** `committed` is false when Escape, a blur, the browser, a lost capture or unmounting ended it. The leaf never sends a revert: the host must put the point back to the snapshot it took at `onDragStart`. */
  onDragEnd?: (id: string, committed: boolean) => void;
  /** The arrow was released or focus left: close the undo step. */
  onNudgeEnd?: (id: string) => void;
};

/** A drag locks to an axis once the pointer is this many px from where the drag started. */
const AXIS_LOCK_PX = 3;

const SCALE_TOP = Math.round(ENVELOPE_TOP_DB * 100) / 100;
const px = (value: number) => `${Math.round(value * 100) / 100}px`;

type Held = { id: string; time: number; db: number; limit: boolean };
type Limits = {
  time: number;
  db: number;
  bounds: Bounds;
  axis: "time" | "db" | null;
};

const HIT_PREFIX = "data-hit-";

/** Only `data-hit-*` string attributes pass; the types say so and this keeps a cast object to it. */
function hitAttrs(attrs: HitAttrs | undefined): HitAttrs | undefined {
  if (!attrs) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith(HIT_PREFIX) && typeof value === "string") {
      clean[name] = value;
    }
  }
  return clean as HitAttrs;
}

const isArrow = (key: string) =>
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "ArrowUp" ||
  key === "ArrowDown";

function stop(event: KeyboardEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
}

type Routes = {
  press: (id: string, event: PointerEvent<HTMLElement>) => void;
  click: (id: string, event: MouseEvent<HTMLElement>) => void;
  keyDown: (id: string, event: KeyboardEvent<HTMLElement>) => void;
  keyUp: (id: string, event: KeyboardEvent<HTMLElement>) => void;
  endNudge: (id: string) => void;
};

type PointProps = Routes & {
  id: string;
  /** 1-based place in time order, for the name. */
  place: number;
  time: number;
  db: number;
  x: number;
  y: number;
  fine: number;
  coarse: number;
  selected: boolean;
  tabStop: boolean;
  dragging: boolean;
  readOnly: boolean;
  hit: EnvelopeHitProps["point"];
};

const EnvelopePoint = memo(function EnvelopePoint({
  id,
  place,
  time,
  db,
  x,
  y,
  fine,
  coarse,
  selected,
  tabStop,
  dragging,
  readOnly,
  hit,
  press,
  click,
  keyDown,
  keyUp,
  endNudge,
}: PointProps) {
  return (
    <span
      className="sys-env-point"
      role="slider"
      tabIndex={tabStop ? 0 : -1}
      aria-label={`Envelope point ${place}`}
      aria-orientation="vertical"
      aria-valuemin={ENVELOPE_FLOOR_DB}
      aria-valuemax={SCALE_TOP}
      aria-valuenow={roundDb(db)}
      aria-valuetext={valueText(db, time)}
      aria-readonly={readOnly || undefined}
      aria-current={selected || undefined}
      {...hitAttrs(hit?.(id, time, db, selected))}
      data-id={id}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      style={
        {
          "--sys-env-x": px(x),
          "--sys-env-y": px(y),
          "--sys-env-fine": px(fine),
          "--sys-env-coarse": px(coarse),
        } as CSSProperties
      }
      onPointerDown={(event) => press(id, event)}
      onClick={(event) => click(id, event)}
      onKeyDown={(event) => keyDown(id, event)}
      onKeyUp={(event) => keyUp(id, event)}
      onBlur={() => endNudge(id)}
    >
      <span className="sys-env-dot" />
    </span>
  );
});

/**
 * The volume envelope over one track's lane (OVL-ENVELOPE, design-system
 * element 15b): a 2 px line in the track colour through the points on a dB
 * scale, a labelled 0 dB guide, and a dot for each point. A click on the line
 * adds a point; a dot is dragged, nudged with the arrow keys, selected and
 * removed. It takes plain data and speaks levels in dB only, so the store's
 * gain never reaches it (`envelopeMath` converts). Only the strip along the
 * line and the dots take a pointer: the rest of the overlay lets a clip
 * under it be tapped and panned.
 */
export const Envelope = memo(function Envelope({
  points,
  trackName,
  colorIndex,
  start,
  pxPerSecond,
  width,
  height,
  top = 0,
  duration = 0,
  selected = null,
  visible = false,
  readOnly = false,
  touch = false,
  anchorProps,
  hitProps,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onDragStart,
  onDragEnd,
  onNudgeEnd,
}: EnvelopeProps) {
  const root = useRef<HTMLDivElement>(null);
  const limits = useRef<Limits | null>(null);
  const nudging = useRef<string | null>(null);
  const last = useRef<Held | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [status, setStatus] = useState("");

  const lane = clampLaneHeight(height);
  const sorted = useMemo(() => sortPoints(points), [points]);
  const drawn = useMemo(
    () =>
      held
        ? sortPoints(
            points.map((point) =>
              point.id === held.id
                ? { ...point, time: held.time, db: held.db }
                : point,
            ),
          )
        : sorted,
    [held, points, sorted],
  );
  const path = useMemo(
    () => linePath(drawn, start, pxPerSecond, width, lane),
    [drawn, start, pxPerSecond, width, lane],
  );
  const lineHit = useMemo(() => hitAttrs(hitProps?.line), [hitProps?.line]);
  const pointHit = hitProps?.point;
  const byId = useMemo(
    () => new Map(points.map((point) => [point.id, point])),
    [points],
  );

  const announce = (text: string, point: { db: number; time: number }) =>
    setStatus(`${text} at ${spokenTime(point.time)}, ${formatDb(point.db)}`);

  const grab = useGrab<{ id: string }>({
    axis: "both",
    canGrab: () => !readOnly,
    captureOnStart: () => root.current,
    onStart: ({ id }, pointer) => {
      if (onDragStart?.(id, pointer) === false) return false;
      const index = sorted.findIndex((point) => point.id === id);
      const point = sorted[index];
      if (!point) return false;
      limits.current = {
        time: point.time,
        db: point.db,
        bounds: pointBounds(sorted, index, duration),
        axis: null,
      };
      if (selected !== id) onSelect(id);
      setHeld({ id, time: point.time, db: point.db, limit: false });
      return true;
    },
    onMove: ({ id }, move) => {
      const from = limits.current;
      if (!from) return;
      if (!from.axis) {
        // A finger's moves count from where it passed the slop, so the lock waits for a real distance.
        if (Math.hypot(move.dx, move.dy) < AXIS_LOCK_PX) return;
        from.axis = Math.abs(move.dx) >= Math.abs(move.dy) ? "time" : "db";
      }
      let held: Held;
      let change: EnvelopeChange;
      if (from.axis === "time") {
        const wanted = move.dx / pxPerSecond;
        const dt = boundedDelta(from.bounds, from.time, wanted);
        const time = dt === 0 ? from.time : round3(from.time + dt);
        held = { id, time, db: from.db, limit: dt !== wanted };
        change = { timeSeconds: time };
      } else {
        const level = dbAfterDrag(from.db, move.dy, lane);
        const db = move.dy === 0 ? from.db : roundDb(level);
        held = {
          id,
          time: from.time,
          db,
          limit: level <= ENVELOPE_FLOOR_DB || level >= ENVELOPE_TOP_DB,
        };
        change = { db };
      }
      last.current = held;
      setHeld(held);
      onMove?.(id, change);
    },
    onEnd: ({ id }, committed) => {
      const now = last.current;
      last.current = null;
      limits.current = null;
      setHeld(null);
      onDragEnd?.(id, committed);
      if (committed && now) announce("Envelope point", now);
    },
  });

  const abortGrab = grab.abort;
  useEffect(() => {
    if (readOnly) abortGrab();
  }, [readOnly, abortGrab]);

  const walk = (from: HTMLElement, direction: -1 | 1) => {
    const dots = root.current?.querySelectorAll<HTMLElement>(".sys-env-point");
    if (!dots) return;
    const list = Array.from(dots);
    list[list.indexOf(from) + direction]?.focus();
  };

  const endNudge = useStableCallback((id: string) => {
    if (nudging.current !== id) return;
    nudging.current = null;
    onNudgeEnd?.(id);
    const point = byId.get(id);
    if (point) announce("Envelope point", point);
  });

  const press = useStableCallback(
    (id: string, event: PointerEvent<HTMLElement>) => grab.press({ id }, event),
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
      if (grab.consumeClick(event)) return;
      onSelect(id);
    },
  );

  const remove = (id: string, from: HTMLElement) => {
    const point = byId.get(id);
    if (!point) return;
    const list = Array.from(
      root.current?.querySelectorAll<HTMLElement>(".sys-env-point") ?? [],
    );
    const at = list.indexOf(from);
    (list[at + 1] ?? list[at - 1])?.focus();
    onRemove?.(id);
    announce("Removed envelope point", point);
  };

  const nudge = (
    id: string,
    key: string,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    const index = sorted.findIndex((point) => point.id === id);
    const point = sorted[index];
    if (!point) return;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const step = timeStep(event.shiftKey) * (key === "ArrowLeft" ? -1 : 1);
      const timeSeconds = round3(
        within(pointBounds(sorted, index, duration), point.time + step),
      );
      if (timeSeconds === point.time) return;
      nudging.current = id;
      onMove?.(id, { timeSeconds });
      return;
    }
    const step =
      levelStep(event.shiftKey, event.altKey) * (key === "ArrowUp" ? 1 : -1);
    const db = round2(clampDb(point.db + step));
    if (db === point.db) return;
    nudging.current = id;
    onMove?.(id, { db });
  };

  const keyDown = useStableCallback(
    (id: string, event: KeyboardEvent<HTMLElement>) => {
      const { key } = event;
      if (event.ctrlKey || event.metaKey) return;
      const dragging = grab.dragging();
      if (key === "Backspace" || key === "Delete") {
        if (event.altKey) return;
        stop(event);
        if (!dragging && selected === id && !readOnly) {
          remove(id, event.currentTarget);
        }
        return;
      }
      if (key === "Enter" || key === " ") {
        stop(event);
        if (!dragging) onSelect(id);
        return;
      }
      if (!isArrow(key)) return;
      if (dragging) {
        stop(event);
        return;
      }
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";
      if (event.altKey && horizontal) {
        stop(event);
        walk(event.currentTarget, key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // Product default (Q1): a read-only guest's plain arrows are not the envelope's; they reach the keymap.
      if (readOnly) {
        // The keymap hears it (playhead on Left and Right, amplitude zoom on Shift+Up and Down), and it
        // calls preventDefault for what it handles; Up and Down it often does not, and the browser would
        // scroll the lane, so a guest's are kept from that without stopping propagation.
        if (key === "ArrowUp" || key === "ArrowDown") event.preventDefault();
        return;
      }
      stop(event);
      nudge(id, key, event);
    },
  );
  const keyUp = useStableCallback(
    (id: string, event: KeyboardEvent<HTMLElement>) => {
      if (isArrow(event.key) && nudging.current === id) {
        event.stopPropagation();
        endNudge(id);
      }
    },
  );

  const add = (event: MouseEvent<SVGElement>) => {
    if (readOnly || !onAdd || grab.consumeClick(event)) return;
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const ceiling = duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const timeSeconds = round3(
      clamp(timeAtX(event.clientX - box.left, start, pxPerSecond), 0, ceiling),
    );
    if (
      sorted.some(
        (point) =>
          Math.abs(point.time - timeSeconds) < ENVELOPE_POINT_GAP_SEC - 1e-9,
      )
    ) {
      return;
    }
    const db = roundDb(yToDb(event.clientY - box.top, lane));
    onAdd(timeSeconds, db);
    announce("Added envelope point", { time: timeSeconds, db });
  };

  useEffect(() => {
    const id = nudging.current;
    if (!id) return;
    const at = drawn.find((point) => point.id === id);
    if (!at || !pointVisible(at.time, start, pxPerSecond, width)) endNudge(id);
  }, [drawn, start, pxPerSecond, width, endNudge]);

  const live = (
    <span className="sr-only" role="status">
      {status}
    </span>
  );
  // The status region keeps its place in the tree either way, so a removal announced as the last
  // point goes is still spoken.
  if (!visible && points.length === 0) {
    return (
      <>
        {null}
        {live}
      </>
    );
  }

  const place = new Map(drawn.map((point, index) => [point.id, index]));
  const shown = drawn.filter(
    (point) =>
      point.id === held?.id ||
      pointVisible(point.time, start, pxPerSecond, width),
  );
  const tabId =
    selected !== null && shown.some((point) => point.id === selected)
      ? selected
      : shown[0]?.id;
  const heldPoint = held ? drawn.find((point) => point.id === held.id) : null;

  const routes: Routes = { press, click, keyDown, keyUp, endNudge };

  return (
    <>
      <div
        ref={root}
        {...anchorProps}
        className="sys-env"
        role="group"
        aria-label={`Volume envelope, ${trackName}`}
        data-readonly={readOnly || undefined}
        data-touch={touch || undefined}
        style={
          {
            "--sys-env-color": presenceColorVar(colorIndex),
            "--sys-env-width": px(width),
            "--sys-env-height": px(lane),
            "--sys-env-top": px(top),
            "--sys-env-zero-y": px(dbToY(0, lane)),
          } as CSSProperties
        }
        onPointerDown={() => grab.clearClick()}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget) cancel(event);
        }}
      >
        <svg
          className="sys-env-svg"
          width={width}
          height={lane}
          aria-hidden="true"
          focusable="false"
        >
          <path className="sys-env-line" d={path} />
          <path className="sys-env-band" d={path} onClick={add} {...lineHit} />
        </svg>
        <span className="sys-env-zero" aria-hidden="true">
          0 dB
        </span>
        {shown.map((point) => {
          const index = place.get(point.id) ?? 0;
          const gap = nearestGapPx(drawn, index, pxPerSecond);
          return (
            <EnvelopePoint
              key={point.id}
              id={point.id}
              place={index + 1}
              time={point.time}
              db={point.db}
              x={xAtTime(point.time, start, pxPerSecond)}
              y={pointY(point.db, lane)}
              fine={2 * hitRadius(false, gap)}
              coarse={2 * hitRadius(true, gap)}
              selected={selected === point.id}
              tabStop={tabId === point.id}
              dragging={held?.id === point.id}
              readOnly={readOnly}
              hit={pointHit}
              {...routes}
            />
          );
        })}
        {held && heldPoint ? (
          <ReadoutChip
            value={readoutText(held.db, held.time)}
            atLimit={held.limit}
            at={{
              x: xAtTime(held.time, start, pxPerSecond),
              y: pointY(held.db, lane),
            }}
          />
        ) : null}
      </div>
      {live}
    </>
  );
});
