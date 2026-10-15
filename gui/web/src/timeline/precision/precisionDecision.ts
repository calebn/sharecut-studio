/**
 * Auto precision (#1184): when a long-press arms a target, should its drag
 * go into precision, or drag directly? Pure; the controller measures the
 * target on screen and calls `decidePrecision`.
 *
 * The rule, in order:
 * 1. **zoom-fine** → direct. One step of the target (10 ms for a trim, 1 ms
 *    for a fade) is at least `DIRECT_PX_PER_STEP` on screen, so a direct
 *    drag can land it despite a fingertip's wobble.
 * 2. **target-narrow** → precision. The target's drawn width is less than
 *    the finger's contact width: the finger covers it.
 * 3. **neighbour-close** → precision. The nearest other target or soft
 *    boundary is closer than the finger is wide.
 * 4. **roomy** → direct.
 *
 * Hysteresis: a target armed again keeps its last mode unless the measure
 * clears the threshold by `HYSTERESIS` (25%), so a measure sitting on a
 * threshold does not flip the mode from one arm to the next.
 */

export interface PrecisionMeasures {
  targetPx: number;
  gapPx: number | null;
  fingerPx: number;
  stepPx: number;
}

export type PrecisionReason =
  | "zoom-fine"
  | "target-narrow"
  | "neighbour-close"
  | "roomy";

export interface PrecisionDecision {
  mode: "direct" | "precision";
  reason: PrecisionReason;
  measures: PrecisionMeasures;
  thresholdPx: number;
  sticky: boolean;
}

export const DIRECT_PX_PER_STEP = 4;

/**
 * The finger's width when the browser reports none: iOS Safari gives a touch
 * a width of 0 or 1. 44 pt is Apple's minimum touch target, the size a
 * fingertip needs (Human Interface Guidelines, Accessibility).
 */
export const FALLBACK_FINGER_PX = 44;

/**
 * A reported contact narrower than this is no fingertip (a fingertip's
 * contact is several mm, tens of CSS px): it is a stylus, or an emulator's
 * default (Chrome DevTools touch reports 2 px), so the fallback stands in.
 */
export const MIN_FINGER_PX = 10;

export const HYSTERESIS = 1.25;

export function fingerWidthPx(width: number, height: number): number {
  const size = Math.max(width, height);
  return size >= MIN_FINGER_PX ? size : FALLBACK_FINGER_PX;
}

type Mode = PrecisionDecision["mode"];

export function decidePrecision(
  measures: PrecisionMeasures,
  previous: Mode | null = null,
): PrecisionDecision {
  const { targetPx, gapPx, fingerPx, stepPx } = measures;
  const margin =
    previous === "precision"
      ? HYSTERESIS
      : previous === "direct"
        ? 1 / HYSTERESIS
        : 1;
  const sticky = margin !== 1;
  const step = DIRECT_PX_PER_STEP * margin;
  if (stepPx >= step) {
    return {
      mode: "direct",
      reason: "zoom-fine",
      measures,
      thresholdPx: step,
      sticky,
    };
  }
  const finger = fingerPx * margin;
  if (targetPx < finger) {
    return {
      mode: "precision",
      reason: "target-narrow",
      measures,
      thresholdPx: finger,
      sticky,
    };
  }
  if (gapPx != null && gapPx < finger) {
    return {
      mode: "precision",
      reason: "neighbour-close",
      measures,
      thresholdPx: finger,
      sticky,
    };
  }
  return {
    mode: "direct",
    reason: "roomy",
    measures,
    thresholdPx: finger,
    sticky,
  };
}

const px = (v: number) => `${Math.round(v * 10) / 10} px`;

export function decisionText(d: PrecisionDecision): string {
  const { targetPx, gapPx, stepPx } = d.measures;
  const limit = `${px(d.thresholdPx)}${d.sticky ? " (sticky)" : ""}`;
  switch (d.reason) {
    case "zoom-fine":
      return `Direct · ${px(stepPx)} per step ≥ ${limit}`;
    case "target-narrow":
      return `Precision · target ${px(targetPx)} < finger ${limit}`;
    case "neighbour-close":
      return `Precision · neighbour ${px(gapPx ?? 0)} < finger ${limit}`;
    case "roomy":
      return `Direct · target ${px(targetPx)}${
        gapPx == null ? "" : `, neighbour ${px(gapPx)}`
      } ≥ finger ${limit}`;
  }
}

export const SLOW_PX_PER_MS = 0.05;
export const FAST_PX_PER_MS = 0.5;

/**
 * The gain of a direct drag for a finger moving at `speed` px/ms when a
 * step is `stepPx` wide: pointer ballistics. A slow finger moves the target
 * at most one step per `DIRECT_PX_PER_STEP` px of travel; a fast one moves it
 * 1:1; in between it rises linearly. Never above 1, never falling with speed.
 */
export function velocityGain(speed: number, stepPx: number): number {
  const slow = Math.min(1, Math.max(stepPx, 0) / DIRECT_PX_PER_STEP);
  if (!(speed > SLOW_PX_PER_MS)) return slow;
  if (speed >= FAST_PX_PER_MS) return 1;
  const t = (speed - SLOW_PX_PER_MS) / (FAST_PX_PER_MS - SLOW_PX_PER_MS);
  return slow + (1 - slow) * t;
}
