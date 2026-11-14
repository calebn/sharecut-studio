import type { TranscriptDetailView } from "../../document/useTranscriptDetail";
import { NEEDS_ATTENTION } from "../../stage/frame/attentionLabel";
import type { CommentDraft } from "../../state/types";

export type ListenInput = {
  /** The link's `comment` capability: the one source for the Comment button and the composer. */
  mayComment: boolean;
  /** The transcript's state, from the real transcript detail: `none` when this link carries no transcript. */
  script: "ready" | "pending" | "failed" | "none";
  /** What a guest sees in the queue: comments, and their own suggestions. */
  counts: { comments: number; suggestions: number };
  hasChapters: boolean;
  /** A refused or waiting edit lives in the queue's Needs attention group. */
  needsAttention: boolean;
  /** `store.commentDraft`. A Viewer never has one. */
  draft: CommentDraft | null;
};

/** What fills the middle: the transcript (or its loading and failure stand-ins), else the chapters, else a Cover. */
type ListenMiddle =
  | { kind: "script" }
  | { kind: "chapters" }
  | { kind: "empty" };

/** The one surface above the dock. The type allows one, so two never show at once. */
export type ListenBottom =
  | {
      kind: "row";
      label: string;
      comments: number;
      /** What the count beside the icon is a count of, for the row's name. */
      afterCount: string;
    }
  | { kind: "composer" }
  | { kind: "none" };

export type ListenLayout = { middle: ListenMiddle; bottom: ListenBottom };

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countLabel(
  { comments, suggestions }: ListenInput["counts"],
  needsAttention: boolean,
): string {
  return [
    comments > 0 ? plural(comments, "comment") : "",
    suggestions > 0 ? plural(suggestions, "suggestion") : "",
    needsAttention ? NEEDS_ATTENTION : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The words that follow the count beside the icon: "comments · 2 suggestions · Needs attention". */
function wordsAfterCount(
  { comments, suggestions }: ListenInput["counts"],
  needsAttention: boolean,
): string {
  return [
    comments === 1 ? "comment" : "comments",
    suggestions > 0 ? plural(suggestions, "suggestion") : "",
    needsAttention ? NEEDS_ATTENTION : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function listenMiddleOf(
  script: ListenInput["script"],
  hasChapters: boolean,
): ListenMiddle {
  return script !== "none"
    ? { kind: "script" }
    : hasChapters
      ? { kind: "chapters" }
      : { kind: "empty" };
}

export function listenLayoutOf(input: ListenInput): ListenLayout {
  const { mayComment, script, counts, hasChapters, needsAttention, draft } =
    input;
  const middle = listenMiddleOf(script, hasChapters);
  const bottom: ListenBottom =
    draft !== null && mayComment
      ? { kind: "composer" }
      : counts.comments + counts.suggestions > 0 || needsAttention
        ? {
            kind: "row",
            label: countLabel(counts, needsAttention),
            comments: counts.comments,
            afterCount: wordsAfterCount(counts, needsAttention),
          }
        : { kind: "none" };
  return { middle, bottom };
}

/**
 * The item closest at or before the playhead, no further back than
 * `windowSec`: the comment the guest is listening past.
 */
export function nearestBefore<T extends { at: number }>(
  items: readonly T[],
  playheadSec: number,
  windowSec: number,
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (item.at > playheadSec || playheadSec - item.at > windowSec) continue;
    if (best === null || item.at > best.at) best = item;
  }
  return best;
}

/** The transcript's state from what the link really carries, never from the role. */
export function listenScriptOf(input: {
  loadFailed: boolean;
  detail: TranscriptDetailView["kind"];
  hasTranscript: boolean;
}): ListenInput["script"] {
  if (input.loadFailed) return "failed";
  switch (input.detail) {
    case "hidden":
      return "none";
    case "ready":
      return input.hasTranscript ? "ready" : "none";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
  }
}
