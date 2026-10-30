import { resolveSelectionRange } from "../edit/rangeSelection";
import type { CommentDraft, DawState } from "../state/types";
import type { ExactRangeTarget } from "../types/project";
import { clampToSession, formatTimeShort } from "../utils/time";

/** Where a new comment's time comes from, strongest first. */
export type CommentAnchorSource = "draft" | "selection" | "playhead";

type CommentAnchor = Readonly<{
  draft: CommentDraft;
  source: CommentAnchorSource;
}>;

type AnchorInputs = Pick<
  DawState,
  "commentDraft" | "selection" | "project" | "playheadSec"
>;

export function commentDraftFromRange(target: ExactRangeTarget): CommentDraft {
  return {
    startSec: target.intervals[0]!.start,
    endSec: target.intervals.at(-1)!.end,
    trackIds: [...target.track_ids],
    intervals: target.intervals,
  };
}

/**
 * The time a comment posted now lands on: the draft that C, the Player bar's
 * comment button or the first keystroke set; else the one selected range; else
 * the playhead.
 */
export function resolveCommentAnchor(s: AnchorInputs): CommentAnchor {
  if (s.commentDraft) return { draft: s.commentDraft, source: "draft" };
  if (s.project) {
    const { targets } = resolveSelectionRange(s.project, s.selection);
    if (targets.length === 1) {
      return { draft: commentDraftFromRange(targets[0]!), source: "selection" };
    }
  }
  const duration = s.project?.timeline_duration_sec ?? Number.NaN;
  return {
    draft: { startSec: clampToSession(s.playheadSec, duration), endSec: null },
    source: "playhead",
  };
}

/** "0:12", or "0:12–0:20" for a span. */
export function commentAnchorLabel(draft: CommentDraft): string {
  const start = formatTimeShort(draft.startSec);
  return draft.endSec != null && draft.endSec > draft.startSec
    ? `${start}–${formatTimeShort(draft.endSec)}`
    : start;
}
