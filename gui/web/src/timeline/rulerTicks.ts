import { formatRulerTime } from "../utils/time";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";

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
 * Estimated worst-case width (px) of the label for `lastSec` (the longest
 * label: times only grow). Labels are `formatRulerTime` at
 * `--font-size-micro` (0.625rem) with `--space-1` padding on both sides. The
 * per-character advance is generous on touch devices, where phone system
 * fonts and text-size scaling render labels wider; on desktop it stays tight
 * so legible end labels are never skipped.
 */
export function estimateRulerLabelWidthPx(
  lastSec: number,
  step: number,
): number {
  const chars = formatRulerTime(lastSec, step).length;
  const coarse = isCoarsePointer();
  return chars * (coarse ? 8 : 6) + (coarse ? 12 : 10);
}

/**
 * Tick indices `i` (at `t = i·step`, never accumulated) whose position lies
 * in chunks `[c0, c1]`, within `[0, durationSec]`.
 */
export function rulerTickIndices(
  chunks: [number, number],
  step: number,
  zoomPxPerSec: number,
  durationSec: number,
): number[] {
  if (!(step > 0) || !(zoomPxPerSec > 0) || !(durationSec >= 0)) {
    return [];
  }
  const x0 = chunks[0] * VIEWPORT_CHUNK_PX;
  const x1 = (chunks[1] + 1) * VIEWPORT_CHUNK_PX;
  const i0 = Math.max(0, Math.ceil(x0 / zoomPxPerSec / step - 1e-9));
  const iEnd = Math.floor(durationSec / step + 1e-9);
  const out: number[] = [];
  for (let i = i0; i <= iEnd && i * step * zoomPxPerSec < x1; i++) {
    out.push(i);
  }
  return out;
}

/**
 * Whether the final tick's right-aligned end label would collide with the
 * previous tick's label; it is then skipped instead of overlapping (#169).
 * Step ticks are always at least `minPx` (70) apart, so only the
 * right-aligned end label, which needs two label widths of clearance, can
 * collide.
 */
export function rulerEndTickDropped(
  durationSec: number,
  step: number,
  zoomPxPerSec: number,
  widthPx: number,
  labelWidthPx: number,
): boolean {
  const last = Math.floor(durationSec / step + 1e-9);
  if (last < 1 || !(zoomPxPerSec > 0) || !(labelWidthPx > 0)) {
    return false;
  }
  const leftPx = last * step * zoomPxPerSec;
  // Mirrors the end-alignment rule in the TimeRuler render.
  if (!(leftPx > widthPx - RULER_END_EDGE_PX)) {
    return false;
  }
  return step * zoomPxPerSec < labelWidthPx * 2;
}
