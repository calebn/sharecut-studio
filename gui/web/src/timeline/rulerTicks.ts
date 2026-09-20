import { formatTimeShort } from "../utils/time";

/**
 * Distance (px) from the ruler's right edge inside which the final tick's
 * label right-aligns instead of overflowing the edge.
 */
export const RULER_END_EDGE_PX = 48;

/**
 * Whether the primary input is coarse (touch). Touch devices use wider
 * system fonts and may apply text-size scaling, so tick labels need a more
 * generous width estimate there (#169).
 */
function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * Estimated worst-case tick label width (px). Labels are `formatTimeShort`
 * (`m:ss` / `h:mm:ss`) at `--font-size-micro` (0.625rem) with `--space-1`
 * padding on both sides. The per-character advance is generous on touch
 * devices, where phone system fonts and text-size scaling render labels
 * wider than the ~29px measured on desktop; on desktop it stays tight so
 * legible end labels are never skipped.
 */
export function estimateRulerLabelWidthPx(ticks: number[]): number {
  const longest = ticks.reduce(
    (n, t) => Math.max(n, formatTimeShort(t).length),
    0,
  );
  const coarse = isCoarsePointer();
  return longest * (coarse ? 8 : 6) + (coarse ? 12 : 10);
}

/**
 * Drop the final tick when its right-aligned end label would collide with
 * the previous tick's label. The final label right-aligns near the ruler's
 * right edge; when there isn't room for both labels, the final one is
 * skipped instead of overlapping (#169). Step ticks are always at least
 * `minPx` (70) apart, so only the right-aligned end label — which needs two
 * label widths of clearance — can collide; one drop always suffices because
 * the new final tick can no longer be near the edge.
 */
export function dropCollidingRulerEndTick(
  ticks: number[],
  zoomPxPerSec: number,
  widthPx: number,
  labelWidthPx: number,
): number[] {
  if (ticks.length < 2 || !(zoomPxPerSec > 0) || !(labelWidthPx > 0)) {
    return ticks;
  }
  const last = ticks[ticks.length - 1]!;
  const leftPx = last * zoomPxPerSec;
  // Mirrors the end-alignment rule in the TimeRuler render.
  if (!(leftPx > widthPx - RULER_END_EDGE_PX && last > 0)) {
    return ticks;
  }
  const prevLeftPx = ticks[ticks.length - 2]! * zoomPxPerSec;
  if (leftPx - prevLeftPx < labelWidthPx * 2) {
    return ticks.slice(0, -1);
  }
  return ticks;
}
