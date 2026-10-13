import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { CommentTimeChip } from "./CommentTimeChip";
import {
  commentAnchorLabel,
  resolveCommentAnchor,
  retimeCommentDraft,
  selectionDiffersNote,
} from "./commentAnchor";

/**
 * The new comment's time, live: it follows the playhead until the person
 * picks a time on the ruler, selects a range, or types one into the chip.
 */
export function CommentAnchorChip() {
  const { label, selectionLabel } = useDaw((s) => ({
    label: commentAnchorLabel(resolveCommentAnchor(s).draft),
    selectionLabel: selectionDiffersNote(s),
  }));
  return (
    <CommentTimeChip
      label={label}
      selectionLabel={selectionLabel}
      onCommit={(text) => {
        const state = useDawStore.getState();
        const next = retimeCommentDraft(
          resolveCommentAnchor(state).draft,
          text,
          state.project?.timeline_duration_sec ?? Number.NaN,
        );
        if (next && "draft" in next) state.setCommentDraft(next.draft);
        return next && "refusal" in next ? next.refusal : null;
      }}
    />
  );
}
