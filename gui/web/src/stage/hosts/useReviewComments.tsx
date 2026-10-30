import { useEffect, useMemo, useRef, useState } from "react";
import { resolveCommentAnchor } from "../../comments/commentAnchor";
import { commentTimeLabel } from "../../comments/commentTimeLabel";
import { playComment } from "../../comments/playComment";
import {
  setCommentResolved,
  useCommentActions,
} from "../../comments/useCommentActions";
import {
  commentPostedStatus,
  usePostComment,
} from "../../comments/usePostComment";
import { stepUndecided } from "../../review/advance";
import {
  commentEntriesOf,
  commentIdOf,
  commentItemId,
} from "../../review/reviewItems";
import type { ReviewFilter, ReviewItem } from "../../review/reviewQueueModel";
import {
  canComment,
  canReply,
  canSetAction,
  commentRole,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { CommentCard } from "../../system/CommentCard";
import { InlineError } from "../../ui";
import { errorMessage } from "../../utils/apiError";
import {
  capCommentName,
  commitCommentActor,
  limitCommentName,
  saveCommentAuthor,
  savedGuestName,
  sessionDisplayName,
} from "../../utils/commentAuthor";
import { ComposeAnchor } from "./ComposeAnchor";
import { commentCardOf } from "./commentCardData";

export type CommentNav = {
  items: readonly ReviewItem[];
  filter: ReviewFilter;
  /** The selection now, not when the key was pressed. */
  selected: () => string | null;
  onSelect: (id: string | null) => void;
  /** Where focus goes when the toast closes. */
  root?: () => HTMLElement | null;
};

/**
 * The comments in the Review queue: one item per comment, the thread on its
 * card, and the field that posts a new one. A host opens the field with C; a
 * guest who may comment always has it, and only a host resolves. Resolving is
 * server state, not a Review decision, so it keeps its own optimistic state
 * and Undo.
 */
export function useReviewComments(guest: boolean) {
  const { project, projectPath, commentDraft, guestMode, capabilities } =
    useDaw((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      commentDraft: s.commentDraft,
      guestMode: s.guestMode,
      capabilities: s.shareCapabilities,
    }));
  const role = commentRole(projectPath, guestMode, guest);
  const mayComment = canComment(projectPath, guestMode, capabilities);
  const mayReply = canReply(projectPath, guestMode, capabilities);
  const mayAction = canSetAction(projectPath, capabilities);
  const showComposer = mayComment && (guest || commentDraft !== null);
  const duration = project?.timeline_duration_sec ?? Number.NaN;
  const comments = project?.comments;
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [replies, setReplies] = useState<Readonly<Record<string, string>>>({});
  const actions = useCommentActions({ role });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(
    new Map<string, { to: boolean; done: Promise<boolean> }>(),
  );
  const posting = useRef(new Set<string>());
  const [postingIds, setPostingIds] = useState<ReadonlySet<string>>(new Set());
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const postComment = usePostComment();
  const [body, setBody] = useState("");
  const [name, setName] = useState(() =>
    guest ? savedGuestName() : sessionDisplayName(role),
  );
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

  // A new draft, from C or the Edit verb, opens the field with focus.
  useEffect(() => {
    if (showComposer && commentDraft) composeRef.current?.focus();
  }, [showComposer, commentDraft]);

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
  // The optimistic value a failed send goes back to, not just "none": the
  // earlier Resolve's snapshot may not have landed yet.
  const flippedNow = useRef(flipped);
  flippedNow.current = flipped;

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
    const before = flippedNow.current.get(c.id) ?? null;
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
    const by = commitCommentActor(null, role);
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
      flip(c.id, before);
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
                const back = flippedNow.current.get(c.id) ?? null;
                flip(c.id, false);
                try {
                  await setCommentResolved(c.id, false, by);
                  sent.current.add(c.id);
                } catch (error) {
                  flip(c.id, back);
                  throw error;
                }
                nav?.onSelect(itemId);
                return true;
              },
              done: "Comment reopened",
            },
            returnFocus: nav?.root,
          }
        : undefined,
    );
  };

  const open = () => {
    const state = useDawStore.getState();
    if (state.commentDraft) composeRef.current?.focus();
    else state.setCommentDraft(resolveCommentAnchor(state).draft);
  };

  // The field unmounts when the draft clears, so focus goes back to the stage
  // (found before it unmounts) and the keyboard keeps its place.
  const stageOf = () =>
    composeRef.current?.closest<HTMLElement>(".rv-stage") ?? null;

  const session = useRef(0);
  const close = () => {
    session.current += 1;
    const stage = stageOf();
    setBody("");
    postComment.cancel();
    useDawStore.getState().setCommentDraft(null);
    stage?.focus({ preventScroll: true });
  };

  const postBusy = useRef(false);
  const post = async () => {
    if (postBusy.current) return;
    postBusy.current = true;
    const stage = stageOf();
    const started = session.current;
    try {
      const result = await postComment.post({
        body,
        author: commitCommentActor(name, role, setName),
      });
      // Escape closed the field while this was in flight: its outcome is moot.
      if (started !== session.current) {
        postComment.setError(null);
        return;
      }
      if (!result.ok) return;
      if (guest && capCommentName(name)) saveCommentAuthor(name, role);
      setBody("");
      useDawStore
        .getState()
        .announceStatus(commentPostedStatus(result.comment));
      stage?.focus({ preventScroll: true });
    } finally {
      postBusy.current = false;
    }
  };

  const type = (value: string) => {
    const state = useDawStore.getState();
    if (value && !state.commentDraft)
      state.setCommentDraft(resolveCommentAnchor(state).draft);
    setBody(value);
  };

  const composer = showComposer ? (
    <div className="rv-compose">
      <ComposeAnchor
        compact
        onEscape={close}
        body={body}
        onBodyChange={type}
        onSubmit={() => void post()}
        name={{
          value: name,
          onChange: (v) => setName(limitCommentName(v)),
        }}
        state={postComment.busy ? "posting" : "idle"}
        inputRef={composeRef}
      />
      <InlineError message={postComment.error} />
    </div>
  ) : undefined;

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
          comment={commentCardOf(c, resolved, duration)}
          onSelect={() => playComment(c)}
          onResolve={
            !guest && resolved ? () => void resolve(c.id, false) : undefined
          }
          onToggleAction={
            mayAction
              ? (actionId, done) => {
                  setAsked(c.id);
                  void actions.toggleAction(c, actionId, done);
                }
              : undefined
          }
          reply={
            mayReply
              ? {
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
                }
              : undefined
          }
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
      composer,
      onReply: () => replyRef.current?.focus(),
    },
    onComment: mayComment ? open : undefined,
    onResolve: (id: string, nav: CommentNav) => {
      const commentId = commentIdOf(id);
      if (commentId) void resolve(commentId, true, nav);
    },
  };
}
