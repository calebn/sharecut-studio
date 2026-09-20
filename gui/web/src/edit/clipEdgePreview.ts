/** Shared clip-edge trim / roll preview math (timeline + transcript). */

export type TrimEdge = "in" | "out";

export type ClipEdgePreview = {
  clipId: string;
  edge: TrimEdge;
  /** Proposed source_start / source_end for the dragged edge. */
  sourceSec: number;
  sourceStart: number;
  sourceEnd: number;
};

export type RollClampBounds = {
  leftSourceStart: number;
  leftSourceEnd: number;
  rightSourceStart: number;
  rightSourceEnd: number;
  /** Previous clip source_end before left, or 0. */
  prevSourceEnd: number;
  /** Next clip source_start after right, or media end / Infinity. */
  nextSourceStart: number;
  mediaEnd?: number;
  minSpan?: number;
};

export function clampTrimSourceSec(
  edge: TrimEdge,
  proposed: number,
  sourceStart: number,
  sourceEnd: number,
  neighborLo: number,
  neighborHi: number,
  minSpan = 0.05,
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

export function sourceSecFromTimelineDelta(
  edge: TrimEdge,
  baseSourceSec: number,
  dxTimelineSec: number,
): number {
  // Timeline grow-right increases source_end; grow-left decreases source_start.
  return edge === "out"
    ? baseSourceSec + dxTimelineSec
    : baseSourceSec + dxTimelineSec;
}

/**
 * Clamp a roll delta so both clips keep min span and stay within neighbor /
 * media source bounds (mirrors ``roll_clip_join`` in clips_ops.py).
 */
export function clampRollDelta(
  deltaSec: number,
  bounds: RollClampBounds,
): number {
  const minSpan = bounds.minSpan ?? 0.05;
  const mediaEnd = bounds.mediaEnd ?? Number.POSITIVE_INFINITY;
  let maxPos = Math.min(
    mediaEnd - bounds.leftSourceEnd,
    bounds.rightSourceEnd - bounds.rightSourceStart - minSpan,
  );
  maxPos = Math.min(maxPos, bounds.nextSourceStart - bounds.rightSourceStart);
  let maxNeg = Math.min(
    bounds.leftSourceEnd - bounds.leftSourceStart - minSpan,
    bounds.rightSourceStart - bounds.prevSourceEnd,
  );
  maxPos = Math.max(0, maxPos);
  maxNeg = Math.max(0, maxNeg);
  return Math.min(Math.max(deltaSec, -maxNeg), maxPos);
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
