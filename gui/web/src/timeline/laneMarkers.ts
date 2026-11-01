import { boundedDelta, spanBounds } from "../system/dragBounds";
import {
  type LaneMarker,
  MARKER_MIN_SPAN,
  type MarkerGrip,
} from "../system/MarkerLane";
import { markerEnd } from "../system/markerLayout";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";

/** A chapter has no id of its own: its time and title name it. */
export function chapterMarkerId(chapter: ChapterMarker): string {
  return `${chapter.time}-${chapter.title}`;
}

export function laneMarkers(input: {
  chapters: readonly ChapterMarker[];
  socialClips: readonly SocialClipView[];
  comments: readonly TimelineComment[];
  showMarkers: boolean;
  showComments: boolean;
}): LaneMarker[] {
  const out: LaneMarker[] = [];
  if (input.showMarkers) {
    for (const chapter of input.chapters)
      out.push({
        kind: "chapter",
        id: chapterMarkerId(chapter),
        start: chapter.time,
        title: chapter.title,
      });
    for (const clip of input.socialClips)
      out.push({
        kind: "clip",
        id: clip.id,
        start: clip.start,
        end: clip.end,
        title: clip.title_suggestion ?? `Social clip ${clip.id}`,
        proposed: !clip.approved,
      });
  }
  if (input.showComments) {
    for (const comment of input.comments)
      out.push({
        kind: "comment",
        id: comment.id,
        start: comment.timeline_start,
        ...(comment.timeline_end != null &&
        comment.timeline_end > comment.timeline_start
          ? { end: comment.timeline_end }
          : {}),
        author: comment.author,
      });
  }
  return out;
}

/**
 * Where a marker sits once it has moved `delta` seconds by `grip`, held to the
 * episode: a chapter moves whole; a social clip moves whole (`move`) or by one
 * bound (`start`, `end`) and keeps its minimum span. Comments never move.
 */
export function movedMarker(
  marker: LaneMarker,
  grip: MarkerGrip,
  delta: number,
  duration: number,
): LaneMarker {
  if (
    marker.kind === "comment" ||
    (marker.kind === "chapter" && grip !== "move")
  )
    return marker;
  const end = markerEnd(marker);
  const value = grip === "end" ? end : marker.start;
  const bounded = boundedDelta(
    spanBounds(grip, marker.start, end, duration, MARKER_MIN_SPAN),
    value,
    delta,
  );
  if (marker.kind === "chapter")
    return { ...marker, start: marker.start + bounded };
  return {
    ...marker,
    start: marker.start + (grip === "end" ? 0 : bounded),
    end: marker.end + (grip === "start" ? 0 : bounded),
  };
}
