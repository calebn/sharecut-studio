import { SNAP_TICK_DECIMALS } from "../utils/timelineZoom.generated";

export type SnapTick = {
  sec: number;
};

const MAGNET_PX = 8;
const SNAP_TICK_SCALE = 10 ** SNAP_TICK_DECIMALS;

export function magnetSec(
  proposedSec: number,
  ticks: number[],
  zoomPxPerSec: number,
  maxPx = MAGNET_PX,
): number {
  if (ticks.length === 0 || !(zoomPxPerSec > 0)) {
    return proposedSec;
  }
  const maxSec = maxPx / zoomPxPerSec;
  let best = proposedSec;
  let bestD = maxSec;
  for (const t of ticks) {
    const d = Math.abs(t - proposedSec);
    if (d <= bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function uniqueTicks(values: number[]): number[] {
  // 1 µs (contract `snap_tick_decimals`, like the server).
  return [
    ...new Set(
      values.map((v) => Math.round(v * SNAP_TICK_SCALE) / SNAP_TICK_SCALE),
    ),
  ].sort((a, b) => a - b);
}
