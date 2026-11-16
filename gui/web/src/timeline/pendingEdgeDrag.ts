import { MIN_EDGE_SPAN_SEC } from "../types/limits.generated";
import {
  ENDPOINT_EPSILON_SEC,
  type PendingEdgePlacement,
  pendingEdgePlacement,
} from "../utils/pendingEdgePlacement";
import { sourceSecInClipToTimeline } from "../utils/timebase";
import { magnetSec } from "./snapOverlay";

export { type PendingEdgePlacement, pendingEdgePlacement };

export type PendingDragEdge = "start" | "end";

export type PendingEdgePreview = {
  sourceStart: number;
  sourceEnd: number;
  timelinePoint: number;
};

/** Move one stored source edge at unit rate, snapping and clamping to its placement. */
export function pendingEdgePreview(opts: {
  edge: PendingDragEdge;
  sourceStart: number;
  sourceEnd: number;
  sourceDeltaSec: number;
  placement: PendingEdgePlacement;
  ticks: number[];
  zoomPxPerSec: number;
}): PendingEdgePreview | null {
  const { edge, sourceStart, sourceEnd, sourceDeltaSec, placement } = opts;
  const proposed =
    (edge === "start" ? sourceStart : sourceEnd) + sourceDeltaSec;
  const snapped = magnetSec(proposed, opts.ticks, opts.zoomPxPerSec);
  const placementStart =
    placement.kind === "clip" ? placement.clip.source_start : 0;
  const placementEnd =
    placement.kind === "clip"
      ? placement.clip.source_end
      : Number.POSITIVE_INFINITY;
  const startLow = placementStart;
  const startHigh = Math.min(placementEnd, sourceEnd - MIN_EDGE_SPAN_SEC);
  const endLow = Math.max(placementStart, sourceStart + MIN_EDGE_SPAN_SEC);
  const endHigh = placementEnd;
  if (
    (edge === "start" && startLow > startHigh) ||
    (edge === "end" && endLow > endHigh)
  ) {
    return null;
  }
  const nextStart =
    edge === "start"
      ? Math.max(startLow, Math.min(startHigh, snapped))
      : sourceStart;
  const nextEnd =
    edge === "end" ? Math.min(endHigh, Math.max(endLow, snapped)) : sourceEnd;
  const sourcePoint = edge === "start" ? nextStart : nextEnd;
  const timelinePoint =
    placement.kind === "identity"
      ? sourcePoint
      : sourceSecInClipToTimeline(placement.clip, sourcePoint);
  if (timelinePoint == null) {
    return null;
  }
  return {
    sourceStart: nextStart,
    sourceEnd: nextEnd,
    timelinePoint,
  };
}

/** Only a visible region edge that is the mapped source endpoint is editable. */
export function pendingOuterEndpoint(
  edge: PendingDragEdge,
  timelinePoint: number | null,
  outerStart: number,
  outerEnd: number,
): boolean {
  if (timelinePoint == null) {
    return false;
  }
  const outerPoint = edge === "start" ? outerStart : outerEnd;
  return Math.abs(timelinePoint - outerPoint) <= ENDPOINT_EPSILON_SEC;
}
