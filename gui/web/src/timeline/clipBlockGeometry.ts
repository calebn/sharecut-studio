import {
  clipGeometryDuringRoll,
  type RollPreview,
  type TrimEdge,
} from "../edit/clipEdgePreview";
import type { ClipRow } from "../types/project";

export type FadeEdge = "in" | "out";
export type ClipFadePreview = { edge: FadeEdge; inMs: number; outMs: number };
export type ClipTrimPreview = {
  edge: TrimEdge;
  sourceStart: number;
  sourceEnd: number;
};

export interface ClipBlockGeometry {
  /** A roll preview names this clip. */
  rollActive: boolean;
  /** Live (preview-aware) source range and its length. */
  sourceStart: number;
  sourceEnd: number;
  durationSec: number;
  /** Timeline x and width of the clip's border box (css px). */
  left: number;
  width: number;
  /** Width of the committed clip, where a trim ghost starts. */
  committedWidth: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Fade lengths in timeline px, following a live drag. */
  fadeInPx: number;
  fadeOutPx: number;
  /** Source second at the trim ghost's left edge. */
  ghostSourceStart: number;
  /** Trim ghost width (css px); 0 when no ghost. */
  ghostExtraPx: number;
  /** Edge of the active fade drag (ms readout), else null. */
  fadeDragEdge: FadeEdge | null;
  /** A trim or roll drag is previewing on this clip. */
  trimDragging: boolean;
}

/** Preview-aware clip geometry shared by the live ClipBlock and its catalog view. */
export function clipBlockGeometry(input: {
  clip: ClipRow;
  zoomPxPerSec: number;
  rollPreview: RollPreview | null;
  trimPreview: ClipTrimPreview | null;
  fadePreview: ClipFadePreview | null;
  previewTimelineStart: number | null;
}): ClipBlockGeometry {
  const { clip, zoomPxPerSec, rollPreview, trimPreview, fadePreview } = input;

  const rollGeom = clipGeometryDuringRoll(clip, rollPreview);
  const rollActive =
    rollPreview != null &&
    (rollPreview.leftClipId === clip.id || rollPreview.rightClipId === clip.id);

  const sourceStart = rollActive
    ? rollGeom.sourceStart
    : (trimPreview?.sourceStart ?? clip.source_start);
  const sourceEnd = rollActive
    ? rollGeom.sourceEnd
    : (trimPreview?.sourceEnd ?? clip.source_end);
  const durationSec = sourceEnd - sourceStart;
  const timelineStart =
    input.previewTimelineStart != null && !rollActive
      ? input.previewTimelineStart
      : rollGeom.timelineStart;
  const left = timelineStart * zoomPxPerSec;
  const width = Math.max(4, durationSec * zoomPxPerSec);
  const committedWidth = Math.max(
    4,
    (clip.source_end - clip.source_start) * zoomPxPerSec,
  );
  const fadeInMs = fadePreview?.inMs ?? clip.fade_in_ms;
  const fadeOutMs = fadePreview?.outMs ?? clip.fade_out_ms;
  // Each edge has one corner handle whatever its length (`.zero` marks a
  // committed 0 ms), so the handle that starts a drag holds pointer capture
  // until it commits.
  const fadeInPx = (fadeInMs / 1000) * zoomPxPerSec;
  const fadeOutPx = (fadeOutMs / 1000) * zoomPxPerSec;
  const growingOut =
    trimPreview != null && trimPreview.sourceEnd > clip.source_end + 1e-9;
  const growingIn =
    trimPreview != null && trimPreview.sourceStart < clip.source_start - 1e-9;
  // In-edge expand keeps timeline_start fixed — duration grows to the right.
  const ghostSourceStart =
    trimPreview == null
      ? clip.source_start
      : growingIn
        ? trimPreview.sourceStart
        : clip.source_end;
  const ghostSourceEnd =
    trimPreview == null
      ? clip.source_end
      : growingIn
        ? clip.source_start
        : trimPreview.sourceEnd;
  const ghostExtraPx =
    trimPreview != null && (growingOut || growingIn)
      ? Math.abs(ghostSourceEnd - ghostSourceStart) * zoomPxPerSec
      : 0;

  return {
    rollActive,
    sourceStart,
    sourceEnd,
    durationSec,
    left,
    width,
    committedWidth,
    fadeInMs,
    fadeOutMs,
    fadeInPx,
    fadeOutPx,
    ghostSourceStart,
    ghostExtraPx,
    fadeDragEdge: fadePreview?.edge ?? null,
    trimDragging: trimPreview != null || rollActive,
  };
}
