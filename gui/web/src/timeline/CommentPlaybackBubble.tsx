import { useCallback } from "react";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { activeCommentId } from "./activeComment";
import { CommentPlaybackBubbleView } from "./CommentPlaybackBubbleView";

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
    activeId == null ? null : (comments.find((c) => c.id === activeId) ?? null);

  return (
    <CommentPlaybackBubbleView
      comment={active}
      zoomPxPerSec={zoomPxPerSec}
      onSelect={onSelect}
    />
  );
}
