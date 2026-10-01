import { MIN_EDGE_SPAN_SEC } from "../edit/clipEdgePreview";
import type { ClipRow } from "../types/project";
import { sourceSecInClipToTimeline } from "../utils/timebase";
import { magnetSec } from "./snapOverlay";

const ENDPOINT_EPSILON_SEC = 1e-5;

export type PendingDragEdge = "start" | "end";

export type PendingEdgePlacement =
  | { kind: "identity" }
  | { kind: "clip"; clip: ClipRow };

export type PendingEdgePreview = {
  sourceStart: number;
  sourceEnd: number;
  timelinePoint: number;
};

/** Match the unique real placement that projects a stored source endpoint. */
export function pendingEdgePlacement(
  clips: readonly ClipRow[],
  sourceSec: number,
  timelineSec: number,
): PendingEdgePlacement | null {
  if (clips.length === 0) {
    return { kind: "identity" };
  }
  const matches = clips.filter((clip) => {
    if (
      sourceSec < clip.source_start - ENDPOINT_EPSILON_SEC ||
      sourceSec > clip.source_end + ENDPOINT_EPSILON_SEC
    ) {
      return false;
    }
    const projected = sourceSecInClipToTimeline(clip, sourceSec);
    return (
      projected != null &&
      Math.abs(projected - timelineSec) <= ENDPOINT_EPSILON_SEC
    );
  });
  return matches.length === 1 ? { kind: "clip", clip: matches[0] } : null;
}

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
