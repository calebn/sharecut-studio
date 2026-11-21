import { useCallback, useRef, useState } from "react";
import { createComment } from "../api";
import { isGuestSession } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { saveCommentAuthor } from "../utils/commentAuthor";
import { isKept, newPostKey } from "../utils/keptPost";
import { resolveCommentAnchor } from "./commentAnchor";
import { commentTimeLabel } from "./commentTimeLabel";

export type CommentInput = {
  body: string;
  author: string;
  /** Tracks the person chose. Empty: the draft's or selected range's own, else session-wide. */
  trackIds?: string[];
  actionTexts?: string[];
};

export type PostResult =
  | { ok: true; comment: TimelineComment | null; kept?: true }
  | { ok: false };

export function commentPostedStatus(comment: TimelineComment | null): string {
  return comment
    ? `Comment posted at ${commentTimeLabel(comment)}`
    : "Comment saved. It posts when you reconnect";
}

/**
 * Posts a comment at the anchor `resolveCommentAnchor` names at the moment of
 * posting. The composer session decides what becomes of the draft.
 * `comment` is null when an offline host queued it or, with `kept`, when a
 * guest's comment waits in the outbox for the host to answer.
 */
export function usePostComment(): {
  error: string | null;
  setError: (message: string | null) => void;
  post: (input: CommentInput) => Promise<PostResult>;
} {
  const [error, setError] = useState<string | null>(null);
  // The same text posted again after a failure keeps its key, so a try that
  // landed without its answer is not made twice.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
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
    const anchor = resolveCommentAnchor(state);
    if (anchor.source === "refreshing") {
      setError(anchor.reason);
      return { ok: false };
    }
    const { draft } = anchor;
    try {
      if (!isGuestSession(state.projectPath, state.guestMode)) {
        saveCommentAuthor(author);
      }
      const trackIds = input.trackIds?.length
        ? input.trackIds
        : (draft.trackIds ?? []);
      const signature = JSON.stringify([
        state.projectPath,
        body,
        author,
        draft.startSec,
        draft.endSec,
        trackIds,
      ]);
      if (attempt.current?.signature !== signature) {
        attempt.current = { signature, key: newPostKey() };
      }
      const comment = await createComment(state.projectPath, {
        body,
        author,
        timelineStart: draft.startSec,
        timelineEnd: draft.endSec,
        trackIds,
        timelineSpans: draft.intervals,
        actionTexts: input.actionTexts ?? [],
        postKey: attempt.current.key,
      });
      attempt.current = null;
      return isKept(comment)
        ? { ok: true, comment: null, kept: true }
        : { ok: true, comment };
    } catch (e) {
      setError(errorMessage(e));
      return { ok: false };
    }
  }, []);

  return { error, setError, post };
}
