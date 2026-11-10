import type { OverviewTick } from "./OverviewStrip";

/** The tick whose position is within `tolerance` (a fraction) of `fraction`, else `fraction` itself. */
export function snapToTick(
  fraction: number,
  ticks: readonly OverviewTick[],
  tolerance: number,
): number {
  let best = fraction;
  let gap = tolerance;
  for (const tick of ticks) {
    const away = Math.abs(tick.at - fraction);
    if (away <= gap) {
      best = tick.at;
      gap = away;
    }
  }
  return best;
}
