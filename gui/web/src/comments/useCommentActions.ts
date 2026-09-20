/**
 * Shared resolve / reply / action-item mutations for host project comments.
 */

import { useCallback, useState } from "react";
import { addCommentReply, patchComment, setCommentActionDone } from "../api";
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
  resolve: (c: TimelineComment, resolved: boolean) => Promise<void>;
  reply: (c: TimelineComment, body: string) => Promise<boolean>;
  toggleAction: (
    c: TimelineComment,
    actionId: string,
    done: boolean,
  ) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { projectPath } = useDaw();
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

  const wrap = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const resolve = useCallback(
    async (c: TimelineComment, resolved: boolean) => {
      const by = actor();
      await wrap(async () => {
        await patchComment(projectPath, c.id, { resolved, by });
      });
    },
    [actor, projectPath, wrap],
  );

  const reply = useCallback(
    async (c: TimelineComment, body: string) => {
      const text = body.trim();
      if (!text) {
        setError("Reply body is required");
        return false;
      }
      const by = actor();
      let ok = false;
      await wrap(async () => {
        await addCommentReply(projectPath, c.id, { body: text, author: by });
        ok = true;
      });
      return ok;
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
