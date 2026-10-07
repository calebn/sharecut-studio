/**
 * How each precision variant (#1184) turns finger travel into time, and the
 * smallest step it lands on.
 *
 * - Jog pad: finger travel at the timeline's zoom, times a gain the finger
 *   picks by sliding up, like iOS media scrubbing's speeds.
 * - Auto-zoom lens: the timeline zooms so about ±1 s fills the time column,
 *   and finger travel moves the target 1:1 at that zoom.
 * - Offset grip: finger travel at the loupe's zoom, which is never coarser
 *   than `GRIP_LOUPE_PX_PER_SEC`.
 *
 * Every variant lands on whole steps of the target's smallest nudge (10 ms
 * for a trim, a pending edge or an envelope point's time, 1 ms for a fade),
 * counted from where the target was armed, so one step is one frame.
 */
import { NUDGE_KINDS, type NudgeField } from "../../edit/nudge";

export const JOG_GAINS = [
  { gain: 1, label: "Full speed" },
  { gain: 1 / 2, label: "Half speed" },
  { gain: 1 / 4, label: "Quarter speed" },
  { gain: 1 / 8, label: "Fine" },
] as const;

export type GainIndex = 0 | 1 | 2 | 3;

/**
 * Finger px per step at the fine speed, however far out the timeline is
 * zoomed: a fingertip's wobble (a px or two) never skips a step.
 */
export const FINE_PX_PER_STEP = 8;

/**
 * The gain at step `index` for a field whose step is `stepSec` long, with
 * `pxPerSec` finger px per second at full speed. Fine is 1/8, or slower
 * still when that would leave a step under `FINE_PX_PER_STEP`.
 */
export function jogGain(
  index: GainIndex,
  pxPerSec: number,
  stepSec: number,
): number {
  const { gain } = JOG_GAINS[index];
  if (index < JOG_GAINS.length - 1) return gain;
  return Math.min(gain, (stepSec * pxPerSec) / FINE_PX_PER_STEP);
}

/**
 * Finger rise (px) above where a jog began that slows it one step. Just under
 * the 44 px touch target, so each step is a deliberate move up.
 */
export const JOG_GAIN_STEP_PX = 40;

/** The gain step for a finger `riseUp` px above where the jog began. */
export function jogGainIndex(riseUp: number): GainIndex {
  const step = Math.floor(Math.max(0, riseUp) / JOG_GAIN_STEP_PX);
  return Math.min(step, JOG_GAINS.length - 1) as GainIndex;
}

/** Half the span the lens shows either side of the armed edge (s). */
export const LENS_HALF_SEC = 1;

/** The lens zoom: `LENS_HALF_SEC` either side of the edge fills `timeViewportPx`. */
export function lensPxPerSec(timeViewportPx: number): number {
  return timeViewportPx / (2 * LENS_HALF_SEC);
}

/** The grip's loupe never shows less than this, so a step is ≥ 2 px. */
export const GRIP_LOUPE_PX_PER_SEC = 200;

/** The grip's loupe zoom at timeline zoom `pxPerSec`. */
export function gripPxPerSec(pxPerSec: number): number {
  return Math.max(pxPerSec, GRIP_LOUPE_PX_PER_SEC);
}

/** One step of `field`: its smallest nudge, in the field's units. */
export function frameOf(field: NudgeField): number {
  return NUDGE_KINDS[field.kind].steps[0];
}

/**
 * Field units per second the moving point travels right: a trim or a pending
 * edge moves its source second by second, a fade-in grows a millisecond per
 * millisecond, and a fade-out shrinks as its corner moves right.
 */
export function unitsPerSec(field: NudgeField): number {
  if (field.kind !== "fade") return 1;
  return field.edge === "in" ? 1000 : -1000;
}

/** `raw` on the nearest whole step from `origin`. */
export function quantize(raw: number, origin: number, frame: number): number {
  const steps = Math.round((raw - origin) / frame);
  return Math.round((origin + steps * frame) * 1e6) / 1e6;
}

/**
 * How far the value moved from where it was armed: "+30 ms", "−1 ms", and
 * past a second "+6.18 s" (a fade keeps its 1 ms steps: "+1.204 s").
 */
export function deltaText(
  field: NudgeField,
  origin: number,
  value: number,
): string {
  const units = field.kind === "fade" ? 1 : 1000;
  const ms = Math.round((value - origin) * units * 1000) / 1000;
  const sign = ms < 0 ? "−" : "+";
  const size = Math.abs(ms);
  if (size < 1000) return `${sign}${size} ms`;
  return `${sign}${(size / 1000).toFixed(field.kind === "fade" ? 3 : 2)} s`;
}
