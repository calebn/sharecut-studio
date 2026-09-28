import type { ProsodyStatus } from "../types/prosody";

/** Energy contour band inside the lane, % from the top. */
export const PROSODY_ENERGY_TOP_PCT = 15;
export const PROSODY_ENERGY_SPAN_PCT = 70;

/** Top offset (%) for an energy step: loudest at the top of the band; 50 when the range is flat or unknown. */
export function energyTopPct(
  db: number,
  range: { min: number; max: number } | null,
): number {
  if (!range || !(range.max > range.min)) return 50;
  const t = Math.min(
    1,
    Math.max(0, (db - range.min) / (range.max - range.min)),
  );
  return PROSODY_ENERGY_TOP_PCT + (1 - t) * PROSODY_ENERGY_SPAN_PCT;
}

/** Whether [startSec, endSec] at `zoom` px/s touches the visible px range [x0, x1]. */
export function inPxRange(
  startSec: number,
  endSec: number,
  zoom: number,
  x0: number,
  x1: number,
): boolean {
  return endSec * zoom >= x0 && startSec * zoom <= x1;
}

/** Lane label for a track whose overlay is not fresh; null when fresh. */
export function prosodyStatusLabel(status: ProsodyStatus): string | null {
  switch (status) {
    case "stale":
      return "Prosody out of date: re-run Analyze prosody";
    case "missing":
      return "No prosody profile: run Analyze prosody";
    case "unavailable":
      return "Prosody unavailable";
    default:
      return null;
  }
}
