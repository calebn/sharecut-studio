import type { TimelineComment } from "../types/project";

function truncate(body: string, max = 80): string {
  const t = body.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

export interface CommentPlaybackBubbleViewProps {
  comment: TimelineComment | null;
  zoomPxPerSec: number;
  onSelect: (comment: TimelineComment) => void;
}

/** Transient bubble while playhead overlaps a comment (at most one). */
export function CommentPlaybackBubbleView({
  comment,
  zoomPxPerSec,
  onSelect,
}: CommentPlaybackBubbleViewProps) {
  if (!comment) {
    return null;
  }

  const left = comment.timeline_start * zoomPxPerSec;

  return (
    <button
      type="button"
      className="comment-playback-bubble"
      style={{ left }}
      title={`${comment.author}: ${comment.body}`}
      onClick={() => onSelect(comment)}
    >
      <span className="comment-playback-bubble-author">{comment.author}</span>
      <span className="comment-playback-bubble-body">
        {truncate(comment.body)}
      </span>
    </button>
  );
}
