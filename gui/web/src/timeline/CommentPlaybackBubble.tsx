import { useCallback } from "react";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { activeCommentId } from "./activeComment";

function truncate(body: string, max = 80): string {
  const t = body.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

interface CommentPlaybackBubbleProps {
  comments: readonly TimelineComment[];
  zoomPxPerSec: number;
  selectedCommentId: string | null;
  visible: boolean;
  onSelect: (comment: TimelineComment) => void;
}

/** Transient bubble while playhead overlaps a comment (at most one). */
export function CommentPlaybackBubble({
  comments,
  zoomPxPerSec,
  selectedCommentId,
  visible,
  onSelect,
}: CommentPlaybackBubbleProps) {
  // Select the id, not the playhead: a tick re-renders only when it changes.
  const activeId = useDawStore(
    useCallback(
      (s: { playheadSec: number }) =>
        visible
          ? activeCommentId(comments, s.playheadSec, selectedCommentId)
          : null,
      [comments, selectedCommentId, visible],
    ),
  );
  const active =
    activeId == null ? null : comments.find((c) => c.id === activeId);

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
