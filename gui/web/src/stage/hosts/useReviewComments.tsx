import { useEffect, useMemo, useRef, useState } from "react";
import { dispatchComposer } from "../../commands/composer";
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
import { useShortLayoutViewport } from "../../hooks/useShortLayoutViewport";
import { stepUndecided } from "../../review/advance";
import {
  commentEntriesOf,
  commentIdOf,
  commentItemId,
} from "../../review/reviewItems";
import type {
  ReviewFilter,
  ReviewItem,
  ReviewSort,
} from "../../review/reviewQueueModel";
import {
  canComment,
  canReply,
  canSetAction,
  commentRole,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { listenLayoutOf } from "../../state/stageRoutes";
import { useDaw } from "../../state/useDaw";
import { CommentCard } from "../../system/CommentCard";
import type { BodyEdit } from "../../system/Composer";
import { InlineError } from "../../ui";
import { errorMessage } from "../../utils/apiError";
import {
  capCommentName,
  commitCommentActor,
  GUEST_SESSION_LABEL,
  limitCommentName,
  saveCommentAuthor,
  savedGuestName,
  sessionDisplayName,
} from "../../utils/commentAuthor";
import { useStableCallback } from "../../utils/useStableCallback";
import { ActionItemsField } from "./ActionItemsField";
import { filledActions } from "./actionItems";
import { ComposeAnchor } from "./ComposeAnchor";
import { commentCardOf } from "./commentCardData";
import { TrackScope } from "./TrackScope";

type ComposerOptions = {
  draftPresent: boolean;
  scope: string[];
  actionLines: string[];
};

export type CommentNav = {
  items: readonly ReviewItem[];
  filter: ReviewFilter;
  speaker?: string | null;
  sort?: ReviewSort;
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
  const {
    project,
    projectPath,
    commentDraft,
    body,
    sending,
    guestMode,
    capabilities,
    shell,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    commentDraft: s.commentDraft,
    body: s.composer.draft?.text ?? "",
    sending: s.composer.post !== null,
    guestMode: s.guestMode,
    capabilities: s.shareCapabilities,
    shell: s.shellBreakpoint,
  }));
  const role = commentRole(projectPath, guestMode, guest);
  const mayComment = canComment(projectPath, guestMode, capabilities);
  const mayReply = canReply(projectPath, guestMode, capabilities);
  const mayAction = canSetAction(projectPath, capabilities);
  // The phone Viewer and Commenter page opens the field from the dock, closes
  // it without losing the text, and plays on again if the dock paused it.
  const listen = listenLayoutOf(shell, guestMode);
  // Any other guest always has the field, docked at the foot on a phone.
  const showComposer =
    mayComment && (commentDraft !== null || (guest && !listen));
  const short = useShortLayoutViewport();
  const docked = shell === "phone" && guest && !listen && !short;
  const duration = project?.timeline_duration_sec ?? Number.NaN;
  const comments = project?.comments;
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [replies, setReplies] = useState<Readonly<Record<string, string>>>({});
  const actions = useCommentActions({ role });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(
    new Map<string, { to: boolean; done: Promise<boolean> }>(),
  );
  const posting = useRef(new Set<string>());
  const [postingIds, setPostingIds] = useState<ReadonlySet<string>>(new Set());
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const postComment = usePostComment();
  const [name, setName] = useState(() =>
    guest ? savedGuestName() : sessionDisplayName(role),
  );
  // Only a guest names themselves, and a browser that already knows the name
  // has nothing left to ask.
  const [nameKnown, setNameKnown] = useState(
    () => guest && capCommentName(savedGuestName()) !== "",
  );
  const [postedRev, setPostedRev] = useState(0);
  const [posted, setPosted] = useState<{ text: string } | null>(null);
  const sent = useRef(new Set<string>());
  const [replyErrors, setReplyErrors] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [asked, setAsked] = useState<string | null>(null);
  const [options, setOptions] = useState<ComposerOptions>(() => ({
    draftPresent: commentDraft !== null,
    scope: [],
    actionLines: [],
  }));
  const draftPresent = commentDraft !== null;
  // The next comment starts on all tracks again.
  if (options.draftPresent !== draftPresent) {
    setOptions({
      draftPresent,
      scope: draftPresent ? options.scope : [],
      actionLines: draftPresent ? options.actionLines : [],
    });
  }
  const { scope, actionLines } = options;
  const tracks = project?.tracks;
  const draftNamesTracks = (commentDraft?.trackIds?.length ?? 0) > 0;
  const scopeTracks =
    !guest && !draftNamesTracks && tracks && tracks.length > 1 ? tracks : null;
  // A person who picked A and then lost A (deleted, or the row hid) posts session-wide, not at a ghost.
  const chosen = scopeTracks
    ? scope.filter((id) => scopeTracks.some((t) => t.id === id))
    : [];

  // Action items are an editor's tool; a guest comment never carries them.
  const mayAct = !guest;

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
  // A link that can no longer comment leaves no draft behind, and plays on what the composer paused.
  useEffect(() => {
    if (!mayComment) dispatchComposer({ type: "reset" });
  }, [mayComment]);

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
  const readFlipped = useStableCallback(() => flipped);

  const resolve = async (
    commentId: string,
    resolved: boolean,
    nav?: CommentNav,
  ) => {
    const c = comments?.find((x) => x.id === commentId);
    const { announceStatus: say } = useDawStore.getState();
    if (!c) return;
    // Same target in flight: a duplicate. The opposite target waits its turn.
    const flight = inFlight.current.get(c.id);
    if (flight) {
      if (flight.to === resolved || !(await flight.done)) return;
      // Another waiter may have sent its own by now.
      if (inFlight.current.has(c.id)) return;
    } else if ((flipped.get(c.id) ?? c.resolved) === resolved) return;
    const itemId = commentItemId(c.id);
    sent.current.delete(c.id);
    const before = readFlipped().get(c.id) ?? null;
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
            nav.speaker ?? null,
            nav.sort ?? "kind",
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
    inFlight.current.set(c.id, mine);
    try {
      await setCommentResolved(c.id, resolved, by);
    } catch (error) {
      flip(c.id, before);
      if (nav?.selected() === next) nav.onSelect(itemId);
      say(errorMessage(error), { tone: "error" });
      settle(false);
      return;
    } finally {
      if (inFlight.current.get(c.id) === mine) inFlight.current.delete(c.id);
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
                const back = readFlipped().get(c.id) ?? null;
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
    if (state.composer.surface === "composer") composeRef.current?.focus();
    else {
      const anchor = resolveCommentAnchor(state);
      if (anchor.source === "refreshing") {
        state.announceStatus(anchor.reason, { tone: "error" });
        return;
      }
      dispatchComposer({
        type: "open",
        anchor: anchor.draft,
        replacePin: anchor.source === "selection",
        listen,
      });
    }
  };

  // The field unmounts when the draft clears, so focus goes back to the stage
  // (found before it unmounts) and the keyboard keeps its place.
  const stageOf = () =>
    composeRef.current?.closest<HTMLElement>(".rv-stage") ?? null;

  // A Post that fails after the field was left has nowhere to say so.
  const leaves = useRef(0);
  const leave = (event: "close" | "discard") => {
    const stage = stageOf();
    leaves.current += 1;
    postComment.setError(null);
    dispatchComposer({ type: event });
    stage?.focus({ preventScroll: true });
  };
  const close = () => {
    setOptions((current) => ({ ...current, scope: [], actionLines: [] }));
    leave("discard");
  };
  /** Listen layout: the typed text and its time wait for the next Comment. */
  const collapse = () => leave("close");

  const postIds = useRef(0);
  // A guest who blanks a saved name posts under it, so show it. The generic
  // "Guest" label stays out of the field: a first post never needs a name.
  const showGuestActor = (who: string) => {
    if (who !== GUEST_SESSION_LABEL) setName(who);
  };

  const post = async () => {
    const { composer: session } = useDawStore.getState();
    if (session.post || !session.draft) return;
    const stage = stageOf();
    const id = ++postIds.current;
    const left = leaves.current;
    dispatchComposer({ type: "postStart", id });
    const result = await postComment.post({
      body: session.draft.text,
      trackIds: chosen,
      actionTexts: mayAct ? filledActions(actionLines) : [],
      author: commitCommentActor(name, role, guest ? showGuestActor : setName),
    });
    if (!result.ok) {
      dispatchComposer({ type: "postFailed", id });
      if (left !== leaves.current) postComment.setError(null);
      return;
    }
    if (guest && capCommentName(name)) {
      saveCommentAuthor(name, role);
      setNameKnown(capCommentName(savedGuestName()) !== "");
    }
    if (guest) {
      setPostedRev((n) => n + 1);
      // A blanked field posted under the saved name: show that name again.
      setName((typed) => (capCommentName(typed) ? typed : savedGuestName()));
    }
    setOptions((current) => ({ ...current, scope: [], actionLines: [] }));
    useDawStore.getState().announceStatus(commentPostedStatus(result.comment));
    setPosted({
      text: result.comment
        ? `Comment added at ${commentTimeLabel(result.comment)}`
        : "Comment saved for later",
    });
    dispatchComposer({ type: "postDone", id });
    stage?.focus({ preventScroll: true });
  };

  const type = (value: string, edit?: BodyEdit) => {
    const state = useDawStore.getState();
    const anchor = resolveCommentAnchor(state);
    // Text is never dropped. While the selection's words are refreshing the
    // draft has no pin (the playhead is not one); the next keystroke that
    // resolves pins it, and Post refuses until then.
    dispatchComposer({
      type: "type",
      text: value,
      composing: edit?.composing ?? false,
      undo: edit?.undo ?? false,
      fresh: anchor.source === "refreshing" ? null : anchor.draft,
    });
  };

  const composer = showComposer ? (
    <div className="rv-compose" data-docked={docked ? "" : undefined}>
      <ComposeAnchor
        compact
        explainEmpty
        onEscape={listen ? collapse : close}
        onClose={listen ? collapse : undefined}
        body={body}
        onBodyChange={type}
        onSubmit={() => void post()}
        name={
          guest
            ? {
                value: name,
                onChange: (v) => setName(limitCommentName(v)),
                saved: nameKnown,
                postedRev,
              }
            : undefined
        }
        state={sending ? "posting" : "idle"}
        inputRef={composeRef}
      />
      {scopeTracks ? (
        <TrackScope
          tracks={scopeTracks}
          value={scope}
          onChange={(next) =>
            setOptions((current) => ({ ...current, scope: next }))
          }
          disabled={sending}
        />
      ) : null}
      {mayAct ? (
        <ActionItemsField
          lines={actionLines}
          onChange={(next) =>
            setOptions((current) => ({ ...current, actionLines: next }))
          }
          disabled={sending}
        />
      ) : null}
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
          onSelect={() => void playComment(c)}
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
      posted,
      onPlayComment: (id: string) => {
        const c = comments?.find((x) => x.id === commentIdOf(id));
        if (c) void playComment(c);
      },
      onReply: () => replyRef.current?.focus(),
    },
    onComment: mayComment ? open : undefined,
    onResolve: (id: string, nav: CommentNav) => {
      const commentId = commentIdOf(id);
      if (commentId) void resolve(commentId, true, nav);
    },
  };
}
