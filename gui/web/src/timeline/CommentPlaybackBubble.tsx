import { useMemo } from "react";
import type { TimelineComment } from "../types/project";

const INSTANT_EPS = 0.35;

function commentCovers(c: TimelineComment, t: number): boolean {
  const start = c.timeline_start;
  const end =
    c.timeline_end != null && c.timeline_end > start
      ? c.timeline_end
      : start + INSTANT_EPS;
  return t >= start && t <= end;
}

function truncate(body: string, max = 80): string {
  const t = body.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

interface CommentPlaybackBubbleProps {
  comments: TimelineComment[];
  playheadSec: number;
  zoomPxPerSec: number;
  selectedCommentId: string | null;
  visible: boolean;
  onSelect: (comment: TimelineComment) => void;
}

/** Transient bubble while playhead overlaps a comment (at most one). */
export function CommentPlaybackBubble({
  comments,
  playheadSec,
  zoomPxPerSec,
  selectedCommentId,
  visible,
  onSelect,
}: CommentPlaybackBubbleProps) {
  const active = useMemo(() => {
    if (!visible) {
      return null;
    }
    const hits = comments.filter((c) => commentCovers(c, playheadSec));
    if (hits.length === 0) {
      return null;
    }
    const selected = hits.find((c) => c.id === selectedCommentId);
    if (selected) {
      return selected;
    }
    return hits.reduce((best, c) => {
      const bestDist = Math.abs(best.timeline_start - playheadSec);
      const dist = Math.abs(c.timeline_start - playheadSec);
      return dist < bestDist ? c : best;
    });
  }, [comments, playheadSec, selectedCommentId, visible]);

  if (!active) {
    return null;
  }

  const left = active.timeline_start * zoomPxPerSec;

  return (
    <button
      type="button"
      className="comment-playback-bubble"
      style={{ left }}
      title={`${active.author}: ${active.body}`}
      onClick={() => onSelect(active)}
    >
      <span className="comment-playback-bubble-author">{active.author}</span>
      <span className="comment-playback-bubble-body">
        {truncate(active.body)}
      </span>
    </button>
  );
}
