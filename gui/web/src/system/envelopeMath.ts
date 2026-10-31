import { ENVELOPE_VALUE_MAX } from "../utils/envelopes";
import { clamp } from "../utils/math";
import { formatRulerTime } from "../utils/time";
import { type Bounds, UNBOUNDED } from "./dragBounds";
import { itemBox, itemVisible } from "./laneMath";
import { xAtTime } from "./rulerMath";

/** The lowest level a point can take. A point at the floor, and a stored gain of 0, are silence. */
export const ENVELOPE_FLOOR_DB = -60;
/** The highest level: the stored gain's ceiling (1.5), which is +3.52 dB. */
export const ENVELOPE_TOP_DB = 20 * Math.log10(ENVELOPE_VALUE_MAX);
/** Empty space above and below the scale, in px. */
export const ENVELOPE_PAD_PX = 4;
/** A drawn point's centre keeps this far from the lane's top and bottom, so a selected point is not cut. */
export const ENVELOPE_POINT_MARGIN_PX = 7;
/** Two points are never closer than this, in seconds. */
export const ENVELOPE_POINT_GAP_SEC = 0.001;

export const DOT_RADIUS_PX = 5;
const HIT_RADIUS_PX = 8;
const HIT_RADIUS_COARSE_PX = 22;

const NUDGE_SEC = 0.01;
const NUDGE_SEC_BIG = 0.1;
const NUDGE_DB = 0.5;
const NUDGE_DB_BIG = 5;
const NUDGE_DB_FINE = 0.05;

export type EnvelopePointData = {
  id: string;
  /** Seconds. */
  time: number;
  /** Decibels, from `ENVELOPE_FLOOR_DB` to `ENVELOPE_TOP_DB`. */
  db: number;
};

const MINUS = "−";

/** The stored gain for a level; the floor and anything below it is gain 0. */
export function dbToGain(db: number): number {
  if (!(db > ENVELOPE_FLOOR_DB)) return 0;
  return Math.min(ENVELOPE_VALUE_MAX, 10 ** (db / 20));
}

/** The level for a stored gain; gain 0 reads as the floor. */
export function gainToDb(gain: number): number {
  if (!(gain > 0)) return ENVELOPE_FLOOR_DB;
  return clamp(20 * Math.log10(gain), ENVELOPE_FLOOR_DB, ENVELOPE_TOP_DB);
}

export function clampDb(db: number): number {
  return clamp(db, ENVELOPE_FLOOR_DB, ENVELOPE_TOP_DB);
}

function pxPerDb(height: number): number {
  return (
    Math.max(height - 2 * ENVELOPE_PAD_PX, 1) /
    (ENVELOPE_TOP_DB - ENVELOPE_FLOOR_DB)
  );
}

/** Where a level lies on the lane, in px from its top. The scale is linear in dB. */
export function dbToY(db: number, height: number): number {
  return ENVELOPE_PAD_PX + (ENVELOPE_TOP_DB - clampDb(db)) * pxPerDb(height);
}

/** The level at a y in px from the lane's top, held to the scale. */
export function yToDb(y: number, height: number): number {
  return clampDb(ENVELOPE_TOP_DB - (y - ENVELOPE_PAD_PX) / pxPerDb(height));
}

/** The level a vertical drag of `dy` px moves a point from `db` to. */
export function dbAfterDrag(db: number, dy: number, height: number): number {
  return clampDb(db - dy / pxPerDb(height));
}

/** Where a point's dot is drawn: its y, kept off the lane's top and bottom. The line itself is not held. */
export function pointY(db: number, height: number): number {
  return clamp(
    dbToY(db, height),
    ENVELOPE_POINT_MARGIN_PX,
    Math.max(ENVELOPE_POINT_MARGIN_PX, height - ENVELOPE_POINT_MARGIN_PX),
  );
}

/** The points by time, and by id where times are equal. */
export function sortPoints(
  points: readonly EnvelopePointData[],
): EnvelopePointData[] {
  return [...points].sort(
    (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The times point `index` of `sorted` may take: between its neighbours, a
 * millisecond clear of each, and inside the episode. A `duration` of 0 (not
 * known yet) leaves the end open. Where the neighbours are too close for that
 * (under two milliseconds apart, or at equal times) the point is held where it
 * is, so a nudge or drag never carries it past one.
 */
export function pointBounds(
  sorted: readonly EnvelopePointData[],
  index: number,
  duration: number,
): Bounds {
  const prev = sorted[index - 1];
  const next = sorted[index + 1];
  const min = prev ? prev.time + ENVELOPE_POINT_GAP_SEC : 0;
  const ceiling = duration > 0 ? duration : UNBOUNDED[1];
  const max = next ? next.time - ENVELOPE_POINT_GAP_SEC : ceiling;
  const top = Math.min(max, ceiling);
  const here = sorted[index];
  if (min > top && here) return [here.time, here.time];
  return [min, Math.max(min, top)];
}

/**
 * Half the width of a point's hit area, in px: 8 on a fine pointer and 22
 * (a 44 px circle) on a coarse one, never more than half the gap to the
 * nearest neighbour, and never less than the dot itself, so under a 10 px gap
 * the hit areas may overlap.
 */
export function hitRadius(coarse: boolean, gapPx: number): number {
  const base = coarse ? HIT_RADIUS_COARSE_PX : HIT_RADIUS_PX;
  return Math.max(DOT_RADIUS_PX, Math.min(base, gapPx / 2));
}

/** The px between a point and the nearest of its neighbours. */
export function nearestGapPx(
  sorted: readonly EnvelopePointData[],
  index: number,
  pxPerSecond: number,
): number {
  const here = sorted[index];
  if (!here) return Number.POSITIVE_INFINITY;
  const before = sorted[index - 1];
  const after = sorted[index + 1];
  const gaps = [
    before ? (here.time - before.time) * pxPerSecond : Number.POSITIVE_INFINITY,
    after ? (after.time - here.time) * pxPerSecond : Number.POSITIVE_INFINITY,
  ];
  return Math.min(...gaps);
}

/** False for a point wholly outside the window, with the slack a clip has. */
export function pointVisible(
  time: number,
  start: number,
  pxPerSecond: number,
  width: number,
): boolean {
  return itemVisible(itemBox(time, 0, start, pxPerSecond), width);
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

/** The stored level resolution, in dB: the finest nudge step is 0.05, and a nudge lands on 0.01. A host stores `dbToGain` of a CHANGED level only. */
export const ENVELOPE_DB_STEP = 0.01;

/** True when two levels are the same at the stored resolution (closer than half of `ENVELOPE_DB_STEP`). */
export function sameLevelDb(a: number, b: number): boolean {
  return Math.abs(a - b) < ENVELOPE_DB_STEP / 2;
}

/** The line is sampled every this many px of height, so a curve is within a small fraction of a px of the true gain curve. */
export const LINE_STEP_PX = 1;

type Spot = { x: number; db: number; gain: number };

/**
 * The line's path in px from the lane's top left. Between two points the
 * level is linear in GAIN, as the audio (`envelopeGainAt`) plays it, so on
 * the dB scale a sloped segment is a curve: it is sampled at equal steps of
 * level, `t = (10^(d/20) - g0) / (g1 - g0)`, which puts every vertex exactly
 * on the curve. Equal levels are one straight piece and equal times a
 * vertical step. The level holds before the first point and after the last, so
 * the line runs flat to both edges of the window. With no points it is the
 * unity line at 0 dB. The path is clipped to the window: every coordinate is
 * in [0, width], whatever the zoom, so a host may pass every point. A point
 * with a time or level that is not finite is left out.
 */
export function linePath(
  sorted: readonly EnvelopePointData[],
  start: number,
  pxPerSecond: number,
  width: number,
  height: number,
): string {
  const spots: Spot[] = [];
  for (const point of sorted) {
    const x = xAtTime(point.time, start, pxPerSecond);
    if (!Number.isFinite(x) || !Number.isFinite(point.db)) continue;
    const db = clampDb(point.db);
    spots.push({ x, db, gain: dbToGain(db) });
  }
  const first = spots[0];
  const last = spots[spots.length - 1];
  if (!first || !last) {
    const y = round2(dbToY(0, height));
    return `M0 ${y}L${width} ${y}`;
  }
  const scale = pxPerDb(height);
  const out: string[] = [];
  let tail = "";
  const put = (x: number, db: number) => {
    const rx = round2(clamp(x, 0, width));
    const here = `${rx} ${round2(dbToY(db, height))}`;
    if (here === tail) return;
    tail = here;
    out.push(`${out.length === 0 ? "M" : "L"}${here}`);
  };
  const flat = (from: number, to: number, db: number) => {
    const lo = Math.max(0, from);
    const hi = Math.min(width, to);
    if (lo > hi) return;
    put(lo, db);
    put(hi, db);
  };
  flat(Number.NEGATIVE_INFINITY, first.x, first.db);
  for (let index = 1; index < spots.length; index += 1) {
    const a = spots[index - 1];
    const b = spots[index];
    if (!a || !b) continue;
    if (b.x <= a.x) {
      if (a.x >= 0 && a.x <= width) {
        put(a.x, a.db);
        put(a.x, b.db);
      }
      continue;
    }
    const lo = Math.max(0, a.x);
    const hi = Math.min(width, b.x);
    if (lo > hi) continue;
    if (a.db === b.db) {
      put(lo, a.db);
      put(hi, a.db);
      continue;
    }
    const span = b.x - a.x;
    const dg = b.gain - a.gain;
    const tLo = (lo - a.x) / span;
    const tHi = (hi - a.x) / span;
    const dLo = lo === a.x ? a.db : gainToDb(a.gain + dg * tLo);
    const dHi = hi === b.x ? b.db : gainToDb(a.gain + dg * tHi);
    put(lo, dLo);
    if (dLo !== dHi) {
      const steps = Math.min(
        Math.ceil((Math.abs(dHi - dLo) * scale) / LINE_STEP_PX),
        Math.max(8, Math.ceil(2 * (hi - lo))),
      );
      // k = 0 and k = steps are on the curve too: where an end is the floor, the curve reaches gain 0.001 (-60 dB) a hair before the point.
      for (let k = 0; k <= steps; k += 1) {
        const db = dLo + ((dHi - dLo) * k) / steps;
        const t = clamp((10 ** (db / 20) - a.gain) / dg, tLo, tHi);
        put(a.x + t * span, db);
      }
    }
    put(hi, dHi);
  }
  flat(last.x, Number.POSITIVE_INFINITY, last.db);
  return out.join("");
}

/** "−3.0 dB", with the minus sign the readout chip uses; a level that rounds to zero has no sign. */
export function formatDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return "0.0 dB";
  const sign = rounded < 0 ? MINUS : "+";
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`;
}

/** "−3.0 dB · 12:04.3": the readout chip's text. */
export function readoutText(db: number, time: number): string {
  return `${formatDb(db)} · ${formatRulerTime(time, 0.1)}`;
}

/** The time a screen reader hears: to 10 ms, the nudge step, so each press changes it. */
export function spokenTime(time: number): string {
  return formatRulerTime(time, 0.01);
}

/** "−3.0 dB at 12:04.30": what a point's slider says. */
export function valueText(db: number, time: number): string {
  return `${formatDb(db)} at ${spokenTime(time)}`;
}

/** A level to 0.1 dB, for `aria-valuenow`. */
export function roundDb(db: number): number {
  return Math.round(db * 10) / 10;
}

/** 10 ms per press, Shift 100 ms. */
export function timeStep(shift: boolean): number {
  return shift ? NUDGE_SEC_BIG : NUDGE_SEC;
}

/** 0.5 dB per press, Shift 5, Alt 0.05. */
export function levelStep(shift: boolean, alt: boolean): number {
  if (alt) return NUDGE_DB_FINE;
  return shift ? NUDGE_DB_BIG : NUDGE_DB;
}
