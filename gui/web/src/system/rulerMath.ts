import { formatRulerTime, niceTimeStep } from "../utils/time";

/** Labels never sit closer than this (px). */
export const RULER_MIN_LABEL_GAP_PX = 64;
/** Plex Mono at 11 px advances about 0.6 em; the padding is the gap before the tick. */
const LABEL_CHAR_PX = 6.6;
const LABEL_PAD_PX = 8;
/** A tick this far left of the window still shows the start of its label. */
const LABEL_BLEED_PX = RULER_MIN_LABEL_GAP_PX;
/** A guard against a window so wide at a tiny step that it would mount thousands of labels. */
const MAX_TICKS = 600;

export type RulerTick = {
  time: number;
  /** Pixels from the ruler's left edge. */
  x: number;
  label: string;
};

/** Seconds at pixel `x` of a window that starts at `start`. */
export function timeAtX(x: number, start: number, pxPerSecond: number): number {
  return start + x / pxPerSecond;
}

/** Pixel position of `time` in a window that starts at `start`. */
export function xAtTime(
  time: number,
  start: number,
  pxPerSecond: number,
): number {
  return (time - start) * pxPerSecond;
}

function labelWidthPx(sec: number, step: number): number {
  return formatRulerTime(sec, step).length * LABEL_CHAR_PX + LABEL_PAD_PX;
}

/**
 * The tick interval: the smallest nice step whose ticks are at least 64 px
 * apart and wider than the widest label in the window, so labels never touch.
 */
export function rulerStep(
  pxPerSecond: number,
  windowEnd: number,
  minGapPx: number = RULER_MIN_LABEL_GAP_PX,
): number {
  const first = niceTimeStep(pxPerSecond, minGapPx);
  const need = labelWidthPx(windowEnd, first);
  return first * pxPerSecond >= need
    ? first
    : niceTimeStep(pxPerSecond, Math.max(minGapPx, need));
}

/**
 * Labelled ticks for the window `[start, start + width / pxPerSecond]`.
 * Each tick is `index * step`, never an accumulated sum, so a deep zoom does
 * not drift.
 */
export function rulerTicks(
  start: number,
  pxPerSecond: number,
  width: number,
  step: number,
  duration: number = Number.POSITIVE_INFINITY,
): RulerTick[] {
  if (!(step > 0) || !(pxPerSecond > 0) || !(width > 0)) return [];
  const end = start + width / pxPerSecond;
  const first = Math.max(
    0,
    Math.ceil((start - LABEL_BLEED_PX / pxPerSecond) / step - 1e-9),
  );
  const last = Math.floor(Math.min(end, duration) / step + 1e-9);
  const ticks: RulerTick[] = [];
  for (let index = first; index <= last && ticks.length < MAX_TICKS; index++) {
    const time = index * step;
    ticks.push({
      time,
      x: xAtTime(time, start, pxPerSecond),
      label: formatRulerTime(time, step),
    });
  }
  return ticks;
}
