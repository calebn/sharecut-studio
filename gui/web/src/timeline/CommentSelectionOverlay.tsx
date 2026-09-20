import type { TimelineComment } from "../types/project";

interface CommentSelectionOverlayProps {
  comment: TimelineComment;
  zoomPxPerSec: number;
  height: number;
}

/** Full-lane outline for the selected comment (instant pin or span). */
export function CommentSelectionOverlay({
  comment,
  zoomPxPerSec,
  height,
}: CommentSelectionOverlayProps) {
  const start = comment.timeline_start;
  const end =
    comment.timeline_end != null && comment.timeline_end > start
      ? comment.timeline_end
      : start;
  const isSpan = end > start;
  const left = start * zoomPxPerSec;
  const width = isSpan ? Math.max(4, (end - start) * zoomPxPerSec) : 4;

  return (
    <div
      className={`comment-selection-overlay${isSpan ? " span" : " pin"}`}
      style={{ left: isSpan ? left : left - 2, width, height }}
      title={`${comment.author}: ${comment.body.slice(0, 80)}`}
    />
  );
}
