export type SnapTick = {
  sec: number;
};

const MAGNET_PX = 8;

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
  return [...new Set(values.map((v) => Math.round(v * 1e4) / 1e4))].sort(
    (a, b) => a - b,
  );
}
