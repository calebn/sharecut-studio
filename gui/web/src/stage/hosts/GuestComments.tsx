import { memo, useCallback, useMemo, useRef, useState } from "react";
import { createComment } from "../../api";
import { seekTransport } from "../../commands/seek";
import { CommentAuthorLine, commentPostedStatus } from "../../comments";
import { useCommentActions } from "../../comments/useCommentActions";
import { useGuestName } from "../../comments/useGuestName";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import {
  canComment,
  canReply,
  canSetAction,
  commentRole,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { CommentCard } from "../../system/CommentCard";
import { Composer } from "../../system/Composer";
import {
  anchorSpan,
  type ComposerAnchor,
  idleAnchor,
  nextAnchor,
} from "../../system/composerAnchor";
import { EmptyState, InlineError } from "../../ui";
import {
  capCommentName,
  GUEST_SESSION_LABEL,
  savedGuestName,
} from "../../utils/commentAuthor";
import { clampToSession } from "../../utils/time";
import { commentCardOf } from "./commentCardData";

type Naming = ReturnType<typeof useGuestName>;

function GuestComposer({ naming }: { naming: Naming }) {
  const { draft, duration } = useDaw((s) => ({
    draft: s.commentDraft,
    duration: s.project?.timeline_duration_sec ?? Number.NaN,
  }));
  const playheadSec = useDawStore(
    useCallback((s: { playheadSec: number }) => Math.floor(s.playheadSec), []),
  );
  const [body, setBody] = useState("");
  const [pin, setPin] = useState<{
    anchor: ComposerAnchor;
    draft: typeof draft;
  } | null>(null);
  const { busy, error, run } = useProjectMutation();
  const posting = useRef(false);
  const playhead = {
    seconds: playheadSec,
    selection:
      draft?.endSec != null
        ? { start: draft.startSec, end: draft.endSec }
        : undefined,
  };
  const pinned = pin && pin.draft === draft ? pin.anchor : null;
  const anchor: ComposerAnchor =
    pinned ??
    (draft
      ? {
          kind: "pinned",
          start: draft.startSec,
          end: draft.endSec ?? undefined,
        }
      : idleAnchor(playhead));

  const submit = async () => {
    if (posting.current || !body.trim()) return;
    posting.current = true;
    const state = useDawStore.getState();
    const exact = anchor.kind === "follow" ? state.playheadSec : undefined;
    const span = anchorSpan(anchor) ?? { start: 0, end: duration };
    const fromDraft =
      draft !== null &&
      anchor.kind === "pinned" &&
      anchor.start === draft.startSec &&
      (anchor.end ?? null) === draft.endSec;
    const author = naming.chosen
      ? naming.name
      : capCommentName(naming.draft) || savedGuestName() || GUEST_SESSION_LABEL;
    const comment = await run(() =>
      createComment(state.projectPath, {
        body: body.trim(),
        author,
        timelineStart: clampToSession(exact ?? span.start, duration),
        timelineEnd:
          span.end === undefined ? null : clampToSession(span.end, duration),
        trackIds: fromDraft ? (draft?.trackIds ?? []) : [],
        timelineSpans: fromDraft ? draft?.intervals : undefined,
      }),
    );
    posting.current = false;
    if (comment === undefined) return;
    if (!naming.chosen) naming.choose(naming.draft);
    setBody("");
    setPin(null);
    state.setCommentDraft(null);
    state.announceStatus(commentPostedStatus(comment));
  };

  return (
    <>
      {naming.showLine ? (
        <CommentAuthorLine name={naming.name} onChange={naming.rename} />
      ) : null}
      <Composer
        body={body}
        onBodyChange={setBody}
        onSubmit={() => void submit()}
        anchor={anchor}
        onAnchor={(intent) =>
          setPin({ anchor: nextAnchor(anchor, intent, playhead), draft })
        }
        name={
          naming.chosen
            ? undefined
            : { value: naming.draft, onChange: naming.setDraft }
        }
        state={busy ? "posting" : "idle"}
      />
      <InlineError message={error} />
    </>
  );
}

function GuestCommentsAdapter({ guestShare }: { guestShare: boolean }) {
  const {
    project,
    projectPath,
    guestMode,
    capabilities,
    selection,
    setSelection,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    capabilities: s.shareCapabilities,
    selection: s.selection,
    setSelection: s.setSelection,
  }));
  const role = commentRole(projectPath, guestMode, guestShare);
  const naming = useGuestName(role);
  const actions = useCommentActions({
    role,
    author: naming.name,
    setAuthor: naming.setName,
  });
  const [replies, setReplies] = useState<Readonly<Record<string, string>>>({});
  const [asked, setAsked] = useState<string | null>(null);
  const comments = project?.comments;
  const sorted = useMemo(
    () =>
      [...(comments ?? [])].sort((a, b) => a.timeline_start - b.timeline_start),
    [comments],
  );
  if (!project) return null;
  const duration = project.timeline_duration_sec;
  const mayReply = canReply(projectPath, guestMode, capabilities);
  const mayAction = canSetAction(projectPath, capabilities);

  return (
    <div className="stage-host-guest-comments">
      {canComment(projectPath, guestMode, capabilities) ? (
        <GuestComposer naming={naming} />
      ) : null}
      {sorted.length === 0 ? (
        <EmptyState>No comments yet.</EmptyState>
      ) : (
        <ul className="stage-host-guest-comment-list">
          {sorted.map((c) => {
            const draft = replies[c.id] ?? "";
            const mine = asked === c.id;
            return (
              <li key={c.id}>
                <CommentCard
                  comment={commentCardOf(c, c.resolved, duration)}
                  selected={
                    selection?.kind === "comment" && selection.id === c.id
                  }
                  onSelect={() => {
                    setSelection({ kind: "comment", id: c.id });
                    void seekTransport(c.timeline_start);
                  }}
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
                            if (actions.busy) return;
                            setAsked(c.id);
                            void actions.reply(c, draft).then((ok) => {
                              if (ok)
                                setReplies((prev) => ({ ...prev, [c.id]: "" }));
                            });
                          },
                          state: mine && actions.busy ? "posting" : "idle",
                        }
                      : undefined
                  }
                />
                <InlineError message={mine ? actions.error : null} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const GuestComments = memo(GuestCommentsAdapter);
