import { useEffect, useMemo, useRef, useState } from "react";
import { commentTimeLabel } from "../../comments/commentTimeLabel";
import { playComment } from "../../comments/playComment";
import {
  setCommentResolved,
  useCommentActions,
} from "../../comments/useCommentActions";
import { stepUndecided } from "../../review/advance";
import {
  commentEntriesOf,
  commentIdOf,
  commentItemId,
} from "../../review/reviewItems";
import type { ReviewFilter, ReviewItem } from "../../review/reviewQueueModel";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { CommentCard, type CommentCardData } from "../../system/CommentCard";
import type { TimelineComment } from "../../types/project";
import { InlineError } from "../../ui";
import { errorMessage } from "../../utils/apiError";
import { commitCommentActor } from "../../utils/commentAuthor";

const COMMENT_ROLE = "host";

export type CommentNav = {
  items: readonly ReviewItem[];
  filter: ReviewFilter;
  onSelect: (id: string | null) => void;
};

const cardOf = (c: TimelineComment, resolved: boolean): CommentCardData => ({
  id: c.id,
  author: c.author,
  at: { start: c.timeline_start, end: c.timeline_end ?? undefined },
  body: c.body,
  resolved,
  resolvedBy: c.resolved_by ?? undefined,
  replies: c.replies.map(({ id, author, body }) => ({ id, author, body })),
  actions: c.action_items.map((a) => ({
    id: a.id,
    text: a.text,
    done: a.done,
    doneBy: a.completed_by ?? undefined,
  })),
});

/**
 * Resolving is server state, not a Review decision, so it keeps its own
 * optimistic state and Undo.
 */
export function useReviewComments(enabled: boolean) {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const comments = enabled ? project?.comments : undefined;
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [replies, setReplies] = useState<Readonly<Record<string, string>>>({});
  const actions = useCommentActions({ role: COMMENT_ROLE });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(new Set<string>());

  useEffect(() => {
    setFlipped((prev) => {
      const kept = [...prev].filter(
        ([id, to]) => comments?.find((c) => c.id === id)?.resolved !== to,
      );
      return kept.length === prev.size ? prev : new Map(kept);
    });
  }, [comments]);

  const entries = useMemo(
    () => commentEntriesOf(comments ?? [], flipped),
    [comments, flipped],
  );

  const flip = (id: string, to: boolean | null) =>
    setFlipped((prev) => {
      const next = new Map(prev);
      if (to === null) next.delete(id);
      else next.set(id, to);
      return next;
    });

  const resolve = async (
    commentId: string,
    resolved: boolean,
    nav?: CommentNav,
  ) => {
    const c = comments?.find((x) => x.id === commentId);
    const { announceStatus: say } = useDawStore.getState();
    if (
      !c ||
      sending.current.has(c.id) ||
      (flipped.get(c.id) ?? c.resolved) === resolved
    )
      return;
    const itemId = commentItemId(c.id);
    flip(c.id, resolved);
    if (nav && resolved)
      nav.onSelect(
        stepUndecided(
          nav.items.map((i) =>
            i.id === itemId ? { ...i, result: "applied" as const } : i,
          ),
          itemId,
          "forward",
          nav.filter,
        ),
      );
    const by = commitCommentActor(null, COMMENT_ROLE);
    sending.current.add(c.id);
    try {
      await setCommentResolved(c.id, resolved, by);
    } catch (error) {
      flip(c.id, null);
      nav?.onSelect(itemId);
      say(errorMessage(error), { tone: "error" });
      return;
    } finally {
      sending.current.delete(c.id);
    }
    say(
      resolved
        ? `Resolved comment at ${commentTimeLabel(c)}`
        : "Comment reopened",
      resolved
        ? {
            reverse: {
              run: async () => {
                if (useDawStore.getState().projectPath !== projectPath)
                  return false;
                await setCommentResolved(c.id, false, by);
                flip(c.id, false);
                nav?.onSelect(itemId);
                return true;
              },
              done: "Comment reopened",
            },
          }
        : undefined,
    );
  };

  const thread = (item: ReviewItem) => {
    const id = commentIdOf(item.id);
    const c = comments?.find((x) => x.id === id);
    if (!c) return undefined;
    const resolved = item.result !== undefined;
    const draft = replies[c.id] ?? "";
    return (
      <>
        <CommentCard
          comment={cardOf(c, resolved)}
          onSelect={() => playComment(c)}
          onResolve={resolved ? () => void resolve(c.id, false) : undefined}
          onToggleAction={(actionId, done) =>
            void actions.toggleAction(c, actionId, done)
          }
          reply={{
            body: draft,
            onBodyChange: (next) =>
              setReplies((prev) => ({ ...prev, [c.id]: next })),
            onSubmit: () =>
              void actions.reply(c, draft).then((ok) => {
                if (ok) setReplies((prev) => ({ ...prev, [c.id]: "" }));
              }),
            state: actions.busy ? "posting" : "idle",
            inputRef: replyRef,
          }}
        />
        <InlineError message={actions.error} />
      </>
    );
  };

  return {
    entries,
    stageProps: {
      thread,
      onReply: () => replyRef.current?.focus(),
    },
    onResolve: (id: string, nav: CommentNav) => {
      const commentId = commentIdOf(id);
      if (commentId) void resolve(commentId, true, nav);
    },
  };
}
