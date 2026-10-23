import { useMemo, useRef, useState } from "react";
import { commandLabel } from "../commands/labels";
import { seekTransport } from "../commands/seek";
import {
  CommentAnchorChip,
  CommentAuthorLine,
  CommentCard,
  CommentCompose,
  commentPostedStatus,
  commentTimeLabel,
  GuestNameStep,
  setCommentResolved,
  useCommentActions,
  useGuestName,
  usePostComment,
} from "../comments";
import { canComment, canReply, canSetAction, commentRole } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { TimelineComment } from "../types/project";
import { EmptyState, InlineError, SegmentedControl, ToggleButton } from "../ui";
import { commitCommentActor } from "../utils/commentAuthor";

type Filter = "open" | "resolved" | "actions" | "all";

export function CommentsPanel({
  guestShare = false,
}: {
  guestShare?: boolean;
}) {
  const {
    project,
    projectPath,
    setSelection,
    commentMode,
    commentDraft,
    setCommentMode,
    selection,
    shareCapabilities,
    guestMode,
    announceStatus,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    setSelection: s.setSelection,
    commentMode: s.commentMode,
    commentDraft: s.commentDraft,
    setCommentMode: s.setCommentMode,
    selection: s.selection,
    shareCapabilities: s.shareCapabilities,
    guestMode: s.guestMode,
    announceStatus: s.announceStatus,
  }));

  const [filter, setFilter] = useState<Filter>("open");
  const role = commentRole(projectPath, guestMode, guestShare);
  const guestName = useGuestName(role);
  const [body, setBody] = useState("");
  const [actionLine, setActionLine] = useState("");
  const [trackIds, setTrackIds] = useState<string[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const { busy: createBusy, error: createError, post } = usePostComment();

  const {
    busy: actionBusy,
    error: actionError,
    setError: setActionError,
    resolve,
    reply,
    toggleAction,
  } = useCommentActions({
    role,
    author: guestName.name,
    setAuthor: guestName.setName,
  });

  const busy = createBusy || actionBusy;
  const error = createError ?? actionError;

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onResolve = async (c: TimelineComment, resolved: boolean) => {
    const ok = await resolve(c, resolved);
    if (!ok || !resolved) return;
    const by = commitCommentActor(guestName.name, role, guestName.setName);
    announceStatus(`Resolved comment at ${commentTimeLabel(c)}`, {
      returnFocus: () => panelRef.current,
      reverse: {
        run: async () => {
          if (useDawStore.getState().projectPath !== projectPath) return false;
          await setCommentResolved(c.id, false, by);
          return true;
        },
        done: "Comment reopened",
      },
    });
  };

  const comments = project?.comments;

  const filtered = useMemo(() => {
    let rows = [...(comments ?? [])];
    if (filter === "open") {
      rows = rows.filter((c) => !c.resolved);
    } else if (filter === "resolved") {
      rows = rows.filter((c) => c.resolved);
    } else if (filter === "actions") {
      rows = rows.filter((c) => c.action_items.some((a) => !a.done));
    }
    rows.sort((a, b) => a.timeline_start - b.timeline_start);
    return rows;
  }, [comments, filter]);

  const createAs = async (who: string) => {
    const result = await post({
      body,
      author: who,
      trackIds,
      actionTexts: actionLine
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    });
    if (!result.ok) {
      bodyRef.current?.focus();
      return;
    }
    setBody("");
    setActionLine("");
    announceStatus(commentPostedStatus(result.comment));
    bodyRef.current?.focus();
  };

  const onCreate = () => {
    setActionError(null);
    const who = guestName.authorForPost();
    return who === null ? Promise.resolve() : createAs(who);
  };

  const focusCompose = () => bodyRef.current?.focus();

  const toggleTrack = (id: string) => {
    setTrackIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  };

  if (!project) {
    return null;
  }

  const mayComment = canComment(projectPath, guestMode, shareCapabilities);
  const mayReply = canReply(projectPath, guestMode, shareCapabilities);
  const mayAction = canSetAction(projectPath, shareCapabilities);

  return (
    <div className="comments-panel" ref={panelRef} tabIndex={-1}>
      <div className="comments-toolbar">
        <CommentAuthorLine name={guestName.name} onChange={guestName.rename} />
        <SegmentedControl className="comments-filters" label="Filter">
          {(
            [
              ["open", "Open"],
              ["actions", "Open actions"],
              ["resolved", "Resolved"],
              ["all", "All"],
            ] as const
          ).map(([id, label]) => (
            <ToggleButton
              key={id}
              quiet
              pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </ToggleButton>
          ))}
        </SegmentedControl>
        {mayComment ? (
          <ToggleButton
            pressed={commentMode}
            onClick={() => setCommentMode(!commentMode)}
          >
            {commandLabel("review.toggleCommentMode")}
          </ToggleButton>
        ) : null}
      </div>

      {mayComment && (
        <CommentCompose
          body={body}
          bodyRef={bodyRef}
          onBodyChange={setBody}
          busy={busy}
          onSubmit={() => void onCreate()}
          anchor={<CommentAnchorChip />}
          bodyPlaceholder="Add a comment…"
          bodyRows={2}
          hideSubmit={guestName.asking}
        >
          {guestName.asking ? (
            <GuestNameStep
              name={guestName.draft}
              onNameChange={guestName.setDraft}
              onConfirm={() => void onCreate()}
              onPostAsGuest={() => void createAs(guestName.choose(""))}
              busy={busy}
              postDisabledReason={
                body.trim() ? undefined : "Write a comment to post."
              }
            />
          ) : null}
          {!guestShare && body.trim() !== "" && (
            <>
              <textarea
                aria-label="Action items (one per line, optional)"
                value={actionLine}
                onChange={(e) => setActionLine(e.target.value)}
                placeholder="Action items (one per line, optional)"
                rows={2}
              />
              <div className="comment-track-picks">
                <span>Tracks (empty = session-wide):</span>
                {project.tracks.map((t) => (
                  <label key={t.id}>
                    <input
                      type="checkbox"
                      checked={(commentDraft?.trackIds ?? trackIds).includes(
                        t.id,
                      )}
                      disabled={commentDraft?.trackIds != null}
                      onChange={() => toggleTrack(t.id)}
                    />
                    {t.label || t.id}
                  </label>
                ))}
              </div>
            </>
          )}
        </CommentCompose>
      )}

      <InlineError message={error} />

      <ul className="comments-list">
        {filtered.map((c: TimelineComment) => {
          const selected =
            selection?.kind === "comment" && selection.id === c.id;
          return (
            <CommentCard
              key={c.id}
              comment={c}
              selected={selected}
              busy={busy}
              guestShare={guestShare}
              swipeToResolve
              replyDraft={replyDrafts[c.id] ?? ""}
              onReplyDraftChange={
                mayReply
                  ? (value) =>
                      setReplyDrafts((prev) => ({ ...prev, [c.id]: value }))
                  : undefined
              }
              onSelect={() => {
                setSelection({ kind: "comment", id: c.id });
                void seekTransport(c.timeline_start);
              }}
              onReply={
                mayReply
                  ? () =>
                      void reply(c, replyDrafts[c.id] ?? "").then((ok) => {
                        if (ok) {
                          setReplyDrafts((prev) => ({ ...prev, [c.id]: "" }));
                        }
                      })
                  : undefined
              }
              onResolve={
                guestShare
                  ? undefined
                  : (resolved) => void onResolve(c, resolved)
              }
              onToggleAction={
                mayAction
                  ? (actionId, done) => void toggleAction(c, actionId, done)
                  : undefined
              }
              showResolve={!guestShare}
              showReply={mayReply}
            />
          );
        })}
        {filtered.length === 0 && (
          <EmptyState
            as="li"
            action={
              filter === "all"
                ? mayComment
                  ? { label: "Add a comment", onClick: focusCompose }
                  : undefined
                : {
                    label: "Show all comments",
                    onClick: () => setFilter("all"),
                  }
            }
          >
            {filter === "all"
              ? "No comments yet."
              : "No comments in this filter."}
          </EmptyState>
        )}
      </ul>
    </div>
  );
}
