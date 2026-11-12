import type { TranscriptDetailView } from "../../document/useTranscriptDetail";
import type { CommentDraft } from "../../state/types";

/** Only links that read and comment get the Listen layout; an Editor keeps Review. */
export type ListenRole = "viewer" | "commenter";

export type ListenInput = {
  role: ListenRole;
  /** The transcript's state, from the real transcript detail: `none` when this link carries no transcript. */
  script: "ready" | "pending" | "failed" | "none";
  /** What a guest sees in the queue: comments, and their own suggestions. */
  counts: { comments: number; suggestions: number };
  hasChapters: boolean;
  /** `store.commentDraft`. A Viewer never has one. */
  draft: CommentDraft | null;
};

/** What fills the middle: the transcript (or its loading and failure stand-ins), else the chapters, else a Cover. */
export type ListenMiddle =
  | { kind: "script" }
  | { kind: "chapters" }
  | { kind: "empty" };

/** The one surface above the dock. The type allows one, so two never show at once. */
export type ListenBottom =
  | { kind: "row"; label: string; comments: number }
  | { kind: "composer" }
  | { kind: "none" };

export type ListenLayout = { middle: ListenMiddle; bottom: ListenBottom };

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "1 comment", "15 comments", "15 comments · 2 suggestions". */
function countLabel({ comments, suggestions }: ListenInput["counts"]): string {
  return [
    comments > 0 ? plural(comments, "comment") : "",
    suggestions > 0 ? plural(suggestions, "suggestion") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function listenLayoutOf(input: ListenInput): ListenLayout {
  const { role, script, counts, hasChapters, draft } = input;
  const middle: ListenMiddle =
    script !== "none"
      ? { kind: "script" }
      : hasChapters
        ? { kind: "chapters" }
        : { kind: "empty" };
  const bottom: ListenBottom =
    draft !== null && role === "commenter"
      ? { kind: "composer" }
      : counts.comments + counts.suggestions > 0
        ? { kind: "row", label: countLabel(counts), comments: counts.comments }
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
  /** The project has utterances at all. */
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
