import type { LaneMarker } from "../system/MarkerLane";
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
