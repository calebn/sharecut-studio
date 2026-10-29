import { errorMessage } from "../utils/apiError";
/**
 * Shared resolve / reply / action-item mutations for host project comments.
 */

import { useCallback, useState } from "react";
import { addCommentReply, setCommentActionDone } from "../api";
import { execute } from "../commands/execute";
import type { CommentRole } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TimelineComment } from "../types/project";
import { commitCommentActor } from "../utils/commentAuthor";

/** Sets a comment's resolved state through the command bus; throws the reason when it is refused. */
export async function setCommentResolved(
  commentId: string,
  resolved: boolean,
  by: string,
): Promise<void> {
  const result = await execute("comment.resolve", { commentId, resolved, by });
  if (result.status !== "ok") {
    throw new Error(
      result.status === "disabled" ? result.reason : "Resolve unavailable",
    );
  }
}

export function useCommentActions(opts: {
  role: CommentRole;
  author?: string;
  setAuthor?: (name: string) => void;
}): {
  busy: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  resolve: (c: TimelineComment, resolved: boolean) => Promise<boolean>;
  reply: (
    c: TimelineComment,
    body: string,
    onError?: (msg: string) => void,
  ) => Promise<boolean>;
  toggleAction: (
    c: TimelineComment,
    actionId: string,
    done: boolean,
  ) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { role, author, setAuthor } = opts;

  const actor = useCallback(
    () => commitCommentActor(author, role, setAuthor),
    [author, role, setAuthor],
  );

  const wrap = useCallback(
    async (
      fn: () => Promise<void>,
      onError: (msg: string) => void = setError,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        return true;
      } catch (e) {
        onError(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const resolve = useCallback(
    async (c: TimelineComment, resolved: boolean) => {
      const by = actor();
      return wrap(() => setCommentResolved(c.id, resolved, by));
    },
    [actor, wrap],
  );

  const reply = useCallback(
    async (
      c: TimelineComment,
      body: string,
      onError?: (msg: string) => void,
    ) => {
      const text = body.trim();
      if (!text) {
        setError("Reply body is required");
        return false;
      }
      const by = actor();
      return wrap(async () => {
        await addCommentReply(projectPath, c.id, { body: text, author: by });
      }, onError);
    },
    [actor, projectPath, wrap],
  );

  const toggleAction = useCallback(
    async (c: TimelineComment, actionId: string, done: boolean) => {
      const by = actor();
      await wrap(async () => {
        await setCommentActionDone(projectPath, c.id, actionId, { done, by });
      });
    },
    [actor, projectPath, wrap],
  );

  return {
    busy,
    error,
    setError,
    resolve,
    reply,
    toggleAction,
    refresh: async () => undefined,
  };
}
