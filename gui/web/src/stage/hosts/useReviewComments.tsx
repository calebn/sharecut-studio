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
  /** The selection now, not when the key was pressed. */
  selected: () => string | null;
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
  const sending = useRef(
    new Map<string, { to: boolean; done: Promise<boolean> }>(),
  );
  const posting = useRef(new Set<string>());
  const [postingIds, setPostingIds] = useState<ReadonlySet<string>>(new Set());
  const sent = useRef(new Set<string>());
  const [replyErrors, setReplyErrors] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [asked, setAsked] = useState<string | null>(null);

  useEffect(() => {
    const landed = new Set(sent.current);
    sent.current.clear();
    setFlipped((prev) => {
      const kept = [...prev].filter(([id, to]) => {
        const now = comments?.find((c) => c.id === id)?.resolved;
        return now !== undefined && now !== to && !landed.has(id);
      });
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
    if (!c) return;
    // Same target in flight: a duplicate. The opposite target waits its turn.
    const flight = sending.current.get(c.id);
    if (flight) {
      if (flight.to === resolved || !(await flight.done)) return;
      // Another waiter may have sent its own by now.
      if (sending.current.has(c.id)) return;
    } else if ((flipped.get(c.id) ?? c.resolved) === resolved) return;
    const itemId = commentItemId(c.id);
    sent.current.delete(c.id);
    flip(c.id, resolved);
    const next =
      nav && resolved
        ? stepUndecided(
            nav.items.map((i) =>
              i.id === itemId ? { ...i, result: "applied" as const } : i,
            ),
            itemId,
            "forward",
            nav.filter,
          )
        : null;
    if (nav && resolved) nav.onSelect(next);
    const by = commitCommentActor(null, COMMENT_ROLE);
    let settle: (ok: boolean) => void = () => {};
    const mine = {
      to: resolved,
      done: new Promise<boolean>((r) => {
        settle = r;
      }),
    };
    sending.current.set(c.id, mine);
    try {
      await setCommentResolved(c.id, resolved, by);
    } catch (error) {
      flip(c.id, null);
      if (nav?.selected() === next) nav.onSelect(itemId);
      say(errorMessage(error), { tone: "error" });
      settle(false);
      return;
    } finally {
      if (sending.current.get(c.id) === mine) sending.current.delete(c.id);
    }
    sent.current.add(c.id);
    settle(true);
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
                sent.current.delete(c.id);
                flip(c.id, false);
                try {
                  await setCommentResolved(c.id, false, by);
                  sent.current.add(c.id);
                } catch (error) {
                  flip(c.id, null);
                  throw error;
                }
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
    const mine = asked === c.id;
    return (
      <>
        <CommentCard
          comment={cardOf(c, resolved)}
          onSelect={() => playComment(c)}
          onResolve={resolved ? () => void resolve(c.id, false) : undefined}
          onToggleAction={(actionId, done) => {
            setAsked(c.id);
            void actions.toggleAction(c, actionId, done);
          }}
          reply={{
            body: draft,
            onBodyChange: (next) =>
              setReplies((prev) => ({ ...prev, [c.id]: next })),
            onSubmit: () => {
              if (posting.current.has(c.id)) return;
              posting.current.add(c.id);
              setPostingIds(new Set(posting.current));
              setAsked(c.id);
              const fail = (msg: string) =>
                setReplyErrors((prev) => ({ ...prev, [c.id]: msg }));
              setReplyErrors((prev) => ({ ...prev, [c.id]: null }));
              void actions.reply(c, draft, fail).then((ok) => {
                posting.current.delete(c.id);
                setPostingIds(new Set(posting.current));
                if (ok) setReplies((prev) => ({ ...prev, [c.id]: "" }));
              });
            },
            state: postingIds.has(c.id) ? "posting" : "idle",
            inputRef: replyRef,
          }}
        />
        <InlineError
          message={replyErrors[c.id] ?? (mine ? actions.error : null)}
        />
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
