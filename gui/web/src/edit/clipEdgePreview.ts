/** Shared clip-edge trim / roll preview math (timeline + transcript). */

import type { ClipRow, ProjectView } from "../types/project";

export type TrimEdge = "in" | "out";

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

/**
 * Clamp a roll delta so both clips keep min span and stay within neighbor /
 * media source bounds (mirrors ``roll_clip_join`` in clips_ops.py).
 */
export function clampRollDelta(
  deltaSec: number,
  bounds: RollClampBounds,
): number {
  const minSpan = bounds.minSpan ?? MIN_EDGE_SPAN_SEC;
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

export type RollNeighborBounds = {
  /** source_end of the clip before the left clip, or 0. */
  prevSourceEnd: number;
  /** source_start of the clip after the right clip, or media end. */
  nextSourceStart: number;
  mediaEnd: number;
};

/** Roll clamp neighbours for a join, from the left clip's track (sorted by timeline). */
export function rollNeighborBounds(
  project: Pick<ProjectView, "clips" | "tracks"> | null,
  leftClip: ClipRow | null,
  rightClip: ClipRow | null,
): RollNeighborBounds {
  if (!leftClip || !rightClip || !project) {
    return {
      prevSourceEnd: 0,
      nextSourceStart: Number.POSITIVE_INFINITY,
      mediaEnd: Number.POSITIVE_INFINITY,
    };
  }
  const trackClips = [...(project.clips.tracks[leftClip.track_id] ?? [])].sort(
    (a, b) => a.timeline_start - b.timeline_start,
  );
  const leftIdx = trackClips.findIndex((c) => c.id === leftClip.id);
  const prev = leftIdx > 0 ? trackClips[leftIdx - 1] : null;
  const rightIdx = trackClips.findIndex((c) => c.id === rightClip.id);
  const next =
    rightIdx >= 0 && rightIdx + 1 < trackClips.length
      ? trackClips[rightIdx + 1]
      : null;
  const track = project.tracks.find((t) => t.id === leftClip.track_id);
  const mediaEnd = track?.duration_sec ?? Number.POSITIVE_INFINITY;
  return {
    prevSourceEnd: prev?.source_end ?? 0,
    nextSourceStart: next?.source_start ?? mediaEnd,
    mediaEnd,
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
