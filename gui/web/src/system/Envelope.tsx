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
import { formatRulerTime } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import { type Bounds, boundedDelta, within } from "./dragBounds";
import {
  clampDb,
  dbAfterDrag,
  dbToY,
  ENVELOPE_FLOOR_DB,
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
  roundDb,
  sortPoints,
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

/** What changed on a point: a time nudge or drag carries `timeSeconds`, a level one `db`; a drag carries both. */
export type EnvelopeChange = { timeSeconds?: number; db?: number };

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
  /** In px. */
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
  onSelect: (id: string) => void;
  /** A click on the line, not on a point. The one callback without an id: the point is new. */
  onAdd?: (timeSeconds: number, db: number) => void;
  onRemove?: (id: string) => void;
  /** A drag calls it on each move and a nudge on each press; the host keeps the point where it says. */
  onMove?: (id: string, change: EnvelopeChange) => void;
  /** First movement of a drag, never a tap. Return `false` to refuse it. */
  onDragStart?: (id: string, pointer: GrabPointer) => boolean | undefined;
  /** `committed` is false when Escape, a blur, the browser, a lost capture or unmounting ended it: the host puts the point back. */
  onDragEnd?: (id: string, committed: boolean) => void;
  /** The arrow was released or focus left: close the undo step. */
  onNudgeEnd?: (id: string) => void;
};

const SCALE_TOP = Math.round(ENVELOPE_TOP_DB * 100) / 100;
const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const round2 = (value: number) => Math.round(value * 100) / 100;

type Held = { id: string; time: number; db: number; limit: boolean };
type Limits = { time: number; db: number; bounds: Bounds };

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
  const byId = useMemo(
    () => new Map(points.map((point) => [point.id, point])),
    [points],
  );

  const announce = (text: string, point: { db: number; time: number }) =>
    setStatus(
      `${text} at ${formatRulerTime(point.time, 0.1)}, ${formatDb(point.db)}`,
    );

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
      };
      if (selected !== id) onSelect(id);
      setHeld({ id, time: point.time, db: point.db, limit: false });
      return true;
    },
    onMove: ({ id }, move) => {
      const from = limits.current;
      if (!from) return;
      const dt = boundedDelta(from.bounds, from.time, move.dx / pxPerSecond);
      const time = round3(from.time + dt);
      const level = dbAfterDrag(from.db, move.dy, lane);
      const db = roundDb(level);
      const limit =
        dt !== move.dx / pxPerSecond ||
        level <= ENVELOPE_FLOOR_DB ||
        level >= ENVELOPE_TOP_DB;
      last.current = { id, time, db, limit };
      setHeld(last.current);
      onMove?.(id, { timeSeconds: time, db });
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

  useEffect(() => {
    if (readOnly && grab.active()) grab.abort();
  });

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
    nudging.current = id;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const step = timeStep(event.shiftKey) * (key === "ArrowLeft" ? -1 : 1);
      const timeSeconds = round3(
        within(pointBounds(sorted, index, duration), point.time + step),
      );
      if (timeSeconds !== point.time) onMove?.(id, { timeSeconds });
      return;
    }
    const step =
      levelStep(event.shiftKey, event.altKey) * (key === "ArrowUp" ? 1 : -1);
    const db = round2(clampDb(point.db + step));
    if (db !== point.db) onMove?.(id, { db });
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
      if (readOnly) return;
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
    const db = roundDb(yToDb(event.clientY - box.top, lane));
    onAdd(timeSeconds, db);
    announce("Added envelope point", { time: timeSeconds, db });
  };

  if (!visible && points.length === 0) return null;

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
        <path className="sys-env-band" d={path} onClick={add} />
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
      <span className="sr-only" role="status">
        {status}
      </span>
    </div>
  );
});
