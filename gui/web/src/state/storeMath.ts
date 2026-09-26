import { minLogicalScrollLeft } from "../utils/timelineViewport";
import { clampZoomPxPerSec } from "../utils/zoom";
import { timelineViewportRegistry } from "./timelineViewportRegistry";
import type { DawState, DawStore } from "./types";
/**
 * The zoom/scroll patch that re-clamps zoom to `sessionSec`'s ceiling, keeping
 * the time at the viewport centre; empty when the zoom already fits. Merge it
 * into the same `set` as the project so no frame shows an over-ceiling zoom.
 */
export function zoomReclampPatch(
  s: Pick<DawStore, "zoomPxPerSec" | "scrollLeft" | "measureTimelineViewport">,
  sessionSec: number,
): Partial<Pick<DawState, "zoomPxPerSec" | "scrollLeft">> {
  const zoom = clampZoomPxPerSec(s.zoomPxPerSec, sessionSec);
  if (zoom === s.zoomPxPerSec) {
    return {};
  }
  const width = s.measureTimelineViewport();
  const centerSec = (s.scrollLeft + width / 2) / s.zoomPxPerSec;
  return {
    zoomPxPerSec: zoom,
    scrollLeft: Math.max(
      minLogicalScrollLeft(timelineViewportRegistry.getLeadPx()),
      centerSec * zoom - width / 2,
    ),
  };
}
