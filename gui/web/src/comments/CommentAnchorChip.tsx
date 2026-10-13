import { useDaw } from "../state/useDaw";
import { clampToSession } from "../utils/time";
import { CommentTimeChip } from "./CommentTimeChip";
import { commentAnchorLabel, resolveCommentAnchor } from "./commentAnchor";

/**
 * The new comment's time, live: it follows the playhead until the person
 * picks a time on the ruler, selects a range, or types one into the chip.
 */
export function CommentAnchorChip() {
  const { label, durationSec, setCommentDraft } = useDaw((s) => ({
    label: commentAnchorLabel(resolveCommentAnchor(s).draft),
    durationSec: s.project?.timeline_duration_sec ?? Number.NaN,
    setCommentDraft: s.setCommentDraft,
  }));
  return (
    <CommentTimeChip
      label={label}
      onChange={(sec) =>
        setCommentDraft({
          startSec: clampToSession(sec, durationSec),
          endSec: null,
        })
      }
    />
  );
}
