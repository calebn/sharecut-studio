import { formatRulerTime, niceTimeStep } from "../utils/time";

/** Every size is in rem, so a larger root font spaces the labels wider rather than overlapping them. */
const MIN_STEP_REM = 4;
/** Plex Mono advances about 0.6 em; the caption token is 0.6875 rem. */
const LABEL_CHAR_REM = 0.6 * 0.6875;
/** The tick's 1 px line and 0.25 rem of padding beside the text. */
const LABEL_PAD_REM = 0.3125;
/** The room kept between two labels. */
const LABEL_GAP_REM = 0.125;
const LABEL_BLEED_REM = MIN_STEP_REM;
/** The root font size the rem figures resolve against by default. */
export const DEFAULT_REM_PX = 16;
/** The playhead's triangle is 10 px wide, so a half-visible one still shows. */
export const PLAYHEAD_BLEED_PX = 6;
/** Stops a tiny step over a wide window from mounting thousands of labels. */
const MAX_TICKS = 600;

type RulerTick = {
  time: number;
  x: number;
  /** Empty when the label would sit on its neighbour's or has no room. */
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

/** A label's room in px, its padding included, at a root font of `rem` px. */
function labelWidthPx(sec: number, step: number, rem: number): number {
  return (
    formatRulerTime(sec, step).length * LABEL_CHAR_REM * rem +
    LABEL_PAD_REM * rem
  );
}

/** The smallest nice step whose ticks are at least 4 rem apart and wider than the widest label in the window, with a gap. */
export function rulerStep(
  pxPerSecond: number,
  windowEnd: number,
  rem: number = DEFAULT_REM_PX,
): number {
  const minGapPx = MIN_STEP_REM * rem;
  const first = niceTimeStep(pxPerSecond, minGapPx);
  const need = labelWidthPx(windowEnd, first, rem) + LABEL_GAP_REM * rem;
  return first * pxPerSecond >= need
    ? first
    : niceTimeStep(pxPerSecond, Math.max(minGapPx, need));
}

/**
 * Each tick is `index * step`, never an accumulated sum, so a deep zoom does not drift.
 * A label that has no room, or would touch its neighbour's, is left off and its line stays; where a tick on the episode's end would have its label touch the one before it, the end label is kept and that one label is dropped.
 */
export function rulerTicks(
  start: number,
  pxPerSecond: number,
  width: number,
  step: number,
  duration: number = Number.POSITIVE_INFINITY,
  rem: number = DEFAULT_REM_PX,
): RulerTick[] {
  if (!(step > 0) || !(pxPerSecond > 0) || !(width > 0)) return [];
  const end = start + width / pxPerSecond;
  const first = Math.max(
    0,
    Math.ceil((start - (LABEL_BLEED_REM * rem) / pxPerSecond) / step - 1e-9),
  );
  const last = Math.floor(Math.min(end, duration) / step + 1e-9);
  const gap = LABEL_GAP_REM * rem;
  const ticks: RulerTick[] = [];
  /** The tick whose label last claimed room, and where that label ends. */
  let kept = -1;
  let keptRight = Number.NEGATIVE_INFINITY;
  for (let index = first; index <= last && ticks.length < MAX_TICKS; index++) {
    const time = index * step;
    const x = xAtTime(time, start, pxPerSecond);
    const label = formatRulerTime(time, step);
    const labelPx = labelWidthPx(time, step, rem);
    const align = x + labelPx > width ? "end" : "start";
    const from = align === "end" ? x - labelPx : x;
    let shown = align === "start" || x >= labelPx;
    if (shown && from < keptRight + gap) {
      const previous = ticks[kept];
      if (align === "end" && previous && time >= duration - 1e-9) {
        previous.label = "";
      } else {
        shown = false;
      }
    }
    ticks.push({ time, x, label: shown ? label : "", align });
    if (shown) {
      kept = ticks.length - 1;
      keptRight = align === "end" ? x : x + labelPx;
    }
  }
  return ticks;
}

export const round3 = (value: number) => Number(value.toFixed(3));
