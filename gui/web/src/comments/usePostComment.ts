import { useCallback, useState } from "react";
import { createComment } from "../api";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { saveCommentAuthor } from "../utils/commentAuthor";
import { resolveCommentAnchor } from "./commentAnchor";

export type CommentInput = {
  body: string;
  author: string;
  /** Session-wide when empty; a draft or selected range names its own. */
  trackIds?: string[];
  actionTexts?: string[];
};

export type PostResult =
  | { ok: true; comment: TimelineComment | null }
  | { ok: false };

/**
 * Posts a comment at the anchor `resolveCommentAnchor` names at the moment of
 * posting, then drops the draft so the next one starts at the playhead again.
 * `comment` is null when an offline host queued it.
 */
export function usePostComment(): {
  busy: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  post: (input: CommentInput) => Promise<PostResult>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(async (input: CommentInput): Promise<PostResult> => {
    setError(null);
    const author = input.author.trim();
    const body = input.body.trim();
    if (!author) {
      setError("Add your name to comment");
      return { ok: false };
    }
    if (!body) return { ok: false };
    const state = useDawStore.getState();
    const { draft } = resolveCommentAnchor(state);
    setBusy(true);
    try {
      saveCommentAuthor(author);
      const comment = await createComment(state.projectPath, {
        body,
        author,
        timelineStart: draft.startSec,
        timelineEnd: draft.endSec,
        trackIds: draft.trackIds ?? input.trackIds ?? [],
        timelineSpans: draft.intervals,
        actionTexts: input.actionTexts ?? [],
      });
      useDawStore.getState().setCommentDraft(null);
      return { ok: true, comment };
    } catch (e) {
      setError(errorMessage(e));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, post };
}
