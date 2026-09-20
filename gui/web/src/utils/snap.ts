/**
 * Snap helpers for on-screen timeline anchors (docs/gui-mobile.md).
 * Only considers anchors currently visible in the viewport.
 */

export function snapToVisibleAnchors(
  sec: number,
  anchorsSec: number[],
  viewStartSec: number,
  viewEndSec: number,
  thresholdSec: number,
): { sec: number; snapped: boolean; anchor: number | null } {
  let best: number | null = null;
  let bestDist = thresholdSec;
  for (const a of anchorsSec) {
    if (a < viewStartSec || a > viewEndSec) {
      continue;
    }
    const d = Math.abs(a - sec);
    if (d <= bestDist) {
      bestDist = d;
      best = a;
    }
  }
  if (best == null) {
    return { sec, snapped: false, anchor: null };
  }
  return { sec: best, snapped: true, anchor: best };
}
