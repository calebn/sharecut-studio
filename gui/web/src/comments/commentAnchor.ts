import { resolveSelectionRange } from "../edit/rangeSelection";
import type { CommentDraft, DawState } from "../state/types";
import type { ExactRangeTarget } from "../types/project";
import { clampToSession, formatTimeShort, parseTimecode } from "../utils/time";

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
 * The time a comment posted now lands on: the draft a ruler press, the time
 * chip or the create menu set; else the one selected range; else the playhead.
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

const RANGE_SEPARATOR = /\s*[–—-]\s*/;

/** The chip's one line when it refuses what was typed. */
export const NOT_A_TIME_HINT = "Try 0:42 or 0:20–0:30";
export const END_BEFORE_START_HINT = "End must be after start";

export type CommentRetime = { draft: CommentDraft } | { refusal: string };

/**
 * The draft after the person types into the time chip: `{ draft }`, or
 * `{ refusal }` with the hint to show when the text is not a time or a span
 * that ends after it starts, or null when the text leaves it as it was. Two
 * times set the span. One time on a span moves the whole span and keeps its
 * length, tracks and intervals; one time on a point moves the point.
 */
export function retimeCommentDraft(
  draft: CommentDraft,
  text: string,
  durationSec: number,
): CommentRetime | null {
  const trimmed = text.trim();
  if (trimmed === commentAnchorLabel(draft)) return null;
  const times = trimmed.split(RANGE_SEPARATOR).map(parseTimecode);
  if (times.length > 2 || times.some((t) => t == null))
    return { refusal: NOT_A_TIME_HINT };
  const [first, second] = times as [number, number | undefined];
  const hasSpan = draft.endSec != null && draft.endSec > draft.startSec;
  if (second != null) {
    const start = clampToSession(first, durationSec);
    const end = clampToSession(second, durationSec);
    if (end <= start) return { refusal: END_BEFORE_START_HINT };
    return {
      draft: {
        ...draft,
        startSec: start,
        endSec: end,
        ...(draft.intervals ? { intervals: [{ start, end }] } : {}),
      },
    };
  }
  if (!hasSpan) {
    return {
      draft: { ...draft, startSec: clampToSession(first, durationSec) },
    };
  }
  const length = draft.endSec! - draft.startSec;
  const start = Math.min(
    clampToSession(first, durationSec),
    Number.isFinite(durationSec)
      ? Math.max(0, durationSec - length)
      : Number.POSITIVE_INFINITY,
  );
  const shift = start - draft.startSec;
  return {
    draft: {
      ...draft,
      startSec: start,
      endSec: start + length,
      ...(draft.intervals
        ? {
            intervals: draft.intervals.map((r) => ({
              start: r.start + shift,
              end: r.end + shift,
            })),
          }
        : {}),
    },
  };
}

/**
 * The selected range's time when the comment's own time is not it, else null.
 * The chip says so beside the time, because the Inspector keeps showing the
 * selection.
 */
export function selectionDiffersNote(s: AnchorInputs): string | null {
  if (!s.project) return null;
  const { draft } = resolveCommentAnchor(s);
  const { targets } = resolveSelectionRange(s.project, s.selection);
  if (targets.length !== 1) return null;
  const selected = commentAnchorLabel(commentDraftFromRange(targets[0]!));
  return selected === commentAnchorLabel(draft) ? null : selected;
}
