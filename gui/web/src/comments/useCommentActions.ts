import { errorMessage } from "../utils/apiError";
/**
 * Shared resolve / reply / action-item mutations for host project comments.
 */

import { useCallback, useState } from "react";
import { addCommentReply, setCommentActionDone } from "../api";
import { execute } from "../commands/execute";
import { useDaw } from "../state/useDaw";
import type { TimelineComment } from "../types/project";
import { resolveCommentActor, saveCommentAuthor } from "../utils/commentAuthor";

export function useCommentActions(opts?: {
  author?: string;
  setAuthor?: (name: string) => void;
}): {
  busy: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  resolve: (c: TimelineComment, resolved: boolean) => Promise<boolean>;
  reply: (c: TimelineComment, body: string) => Promise<boolean>;
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
  const author = opts?.author;
  const setAuthor = opts?.setAuthor;

  const actor = useCallback(() => {
    const who = resolveCommentActor(author);
    setAuthor?.(who);
    saveCommentAuthor(who);
    return who;
  }, [author, setAuthor]);

  const wrap = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        return true;
      } catch (e) {
        setError(errorMessage(e));
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
      return wrap(async () => {
        const result = await execute("comment.resolve", {
          commentId: c.id,
          resolved,
          by,
        });
        if (result.status !== "ok") {
          throw new Error(
            result.status === "disabled"
              ? result.reason
              : "Resolve unavailable",
          );
        }
      });
    },
    [actor, wrap],
  );

  const reply = useCallback(
    async (c: TimelineComment, body: string) => {
      const text = body.trim();
      if (!text) {
        setError("Reply body is required");
        return false;
      }
      const by = actor();
      return wrap(async () => {
        await addCommentReply(projectPath, c.id, { body: text, author: by });
      });
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
