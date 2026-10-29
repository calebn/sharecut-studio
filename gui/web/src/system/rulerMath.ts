import { formatRulerTime, niceTimeStep } from "../utils/time";

const RULER_MIN_LABEL_GAP_PX = 64;
/** Plex Mono at 11 px advances about 0.6 em. */
const LABEL_CHAR_PX = 6.6;
const LABEL_PAD_PX = 8;
const LABEL_BLEED_PX = RULER_MIN_LABEL_GAP_PX;
/** Stops a tiny step over a wide window from mounting thousands of labels. */
const MAX_TICKS = 600;

type RulerTick = {
  time: number;
  x: number;
  /** Empty when a right-aligned label would sit on its neighbour's. */
  label: string;
  /** `end` puts the label left of its line, for a tick too near the window's right edge. */
  align: "start" | "end";
};

export function timeAtX(x: number, start: number, pxPerSecond: number): number {
  return start + x / pxPerSecond;
}

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

/** The smallest nice step whose ticks are at least `minGapPx` apart and wider than the widest label in the window. */
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

/** Each tick is `index * step`, never an accumulated sum, so a deep zoom does not drift. */
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
    const x = xAtTime(time, start, pxPerSecond);
    const label = formatRulerTime(time, step);
    const labelPx = labelWidthPx(time, step);
    const align = x + labelPx > width ? "end" : "start";
    const clash =
      align === "end" && step * pxPerSecond < 2 * labelPx - LABEL_PAD_PX;
    ticks.push({ time, x, label: clash ? "" : label, align });
  }
  return ticks;
}

export const round3 = (value: number) => Number(value.toFixed(3));
