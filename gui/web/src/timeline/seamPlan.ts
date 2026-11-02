import { clampZoomPxPerSec } from "../utils/zoom";
import type { AppliedTick } from "./appliedEditTicks";

/** Seams closer than this (canvas px) fold into one count chip, so every target keeps its 24 px. */
export const SEAM_CLUSTER_PX = 24;

export type PlacedSeam = { kind: "seam"; tick: AppliedTick; xPx: number };
export type PlacedSeamChip = {
  kind: "chip";
  ticks: readonly AppliedTick[];
  xPx: number;
  startSec: number;
  endSec: number;
  /** The zoom that splits the group, or null when zooming in cannot. */
  zoomTo: number | null;
};

export function planSeams(
  ticks: readonly AppliedTick[],
  zoomPxPerSec: number,
  sessionSec: number,
): (PlacedSeam | PlacedSeamChip)[] {
  const sorted = [...ticks].sort((a, b) => a.sec - b.sec);
  const groups: AppliedTick[][] = [];
  for (const tick of sorted) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (
      last &&
      prev &&
      (tick.sec - prev.sec) * zoomPxPerSec < SEAM_CLUSTER_PX
    ) {
      last.push(tick);
    } else {
      groups.push([tick]);
    }
  }
  return groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (group.length === 1) {
      return { kind: "seam", tick: first, xPx: first.sec * zoomPxPerSec };
    }
    let minGap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < group.length; i += 1) {
      minGap = Math.min(minGap, group[i].sec - group[i - 1].sec);
    }
    const needed =
      minGap > 0 ? (1.25 * SEAM_CLUSTER_PX) / minGap : Number.POSITIVE_INFINITY;
    const target = clampZoomPxPerSec(needed, sessionSec);
    return {
      kind: "chip",
      ticks: group,
      xPx: ((first.sec + last.sec) / 2) * zoomPxPerSec,
      startSec: first.sec,
      endSec: last.sec,
      zoomTo: target > zoomPxPerSec ? target : null,
    };
  });
}
