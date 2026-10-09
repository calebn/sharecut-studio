/** Shared clip-edge trim / roll preview math (timeline + transcript). */

export type TrimEdge = "in" | "out";
/** What an edit does to the time after it: ripple closes or opens it on every dialogue track; gap moves nothing else. */
export type EditMode = "ripple" | "gap";

/** Shortest span (seconds) an edge drag may leave: clip trims and rolls, pending edits and social clips. */
export const MIN_EDGE_SPAN_SEC = 0.05;

export type ClipEdgePreview = {
  clipId: string;
  edge: TrimEdge;
  /** Proposed source_start / source_end for the dragged edge. */
  sourceSec: number;
  sourceStart: number;
  sourceEnd: number;
};

export function clampTrimSourceSec(
  edge: TrimEdge,
  proposed: number,
  sourceStart: number,
  sourceEnd: number,
  neighborLo: number,
  neighborHi: number,
  minSpan = MIN_EDGE_SPAN_SEC,
): number {
  if (edge === "out") {
    const lo = sourceStart + minSpan;
    const hi = neighborHi;
    return Math.min(Math.max(proposed, lo), hi);
  }
  const lo = neighborLo;
  const hi = sourceEnd - minSpan;
  return Math.min(Math.max(proposed, lo), hi);
}

/**
 * Source second after a timeline drag of `dxTimelineSec`. The same for both
 * edges: dragging right grows source_end / shrinks from source_start, and a
 * left drag's negative dx lowers either edge.
 */
export function sourceSecFromTimelineDelta(
  baseSourceSec: number,
  dxTimelineSec: number,
): number {
  return baseSourceSec + dxTimelineSec;
}

export type RollPreview = {
  leftClipId: string;
  rightClipId: string;
  deltaSec: number;
};

/** Live geometry for one clip while a join roll is previewed (both sides stay flush). */
export function clipGeometryDuringRoll(
  clip: {
    id: string;
    source_start: number;
    source_end: number;
    timeline_start: number;
  },
  preview: RollPreview | null,
): { sourceStart: number; sourceEnd: number; timelineStart: number } {
  if (preview == null) {
    return {
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end,
      timelineStart: clip.timeline_start,
    };
  }
  if (preview.leftClipId === clip.id) {
    return {
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end + preview.deltaSec,
      timelineStart: clip.timeline_start,
    };
  }
  if (preview.rightClipId === clip.id) {
    return {
      sourceStart: clip.source_start + preview.deltaSec,
      sourceEnd: clip.source_end,
      timelineStart: clip.timeline_start + preview.deltaSec,
    };
  }
  return {
    sourceStart: clip.source_start,
    sourceEnd: clip.source_end,
    timelineStart: clip.timeline_start,
  };
}

/**
 * `clip` with a roll preview applied, as a row, so join rules such as
 * `isDrawnJoin` see what ClipBlock draws live. Returns `clip` itself when the
 * preview does not touch it.
 */
export function clipRowDuringRoll<
  T extends {
    id: string;
    source_start: number;
    source_end: number;
    timeline_start: number;
    timeline_end: number;
  },
>(clip: T, preview: RollPreview | null): T {
  if (
    preview == null ||
    (preview.leftClipId !== clip.id && preview.rightClipId !== clip.id)
  ) {
    return clip;
  }
  const geom = clipGeometryDuringRoll(clip, preview);
  return {
    ...clip,
    source_start: geom.sourceStart,
    source_end: geom.sourceEnd,
    timeline_start: geom.timelineStart,
    timeline_end:
      preview.leftClipId === clip.id
        ? clip.timeline_end + preview.deltaSec
        : clip.timeline_end,
  };
}
