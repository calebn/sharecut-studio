import type { CommentDraft } from "./types";

/** The same comment anchor, no longer promising to play the episode on again. */
export function withoutResume(draft: CommentDraft): CommentDraft {
  const { resume: _resume, ...rest } = draft;
  return rest;
}

/** `next` is `previous` after the transport was touched: the anchor did not change. */
export function isResumeDropped(
  previous: CommentDraft | null,
  next: CommentDraft | null,
): boolean {
  if (!previous?.resume || !next || next.resume) return false;
  const kept = Object.entries(withoutResume(previous));
  return (
    kept.length === Object.keys(next).length &&
    kept.every(([key, value]) => next[key as keyof CommentDraft] === value)
  );
}
