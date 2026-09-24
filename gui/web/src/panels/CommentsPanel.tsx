import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createComment } from "../api";
import {
  CommentCard,
  CommentCompose,
  commentTimeLabel,
  useCommentActions,
} from "../comments";
import { canComment, canReply, canSetAction } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TimelineComment } from "../types/project";
import {
  EmptyState,
  InlineError,
  SegmentedControl,
  ToggleButton,
  UndoToast,
  type UndoToastState,
} from "../ui";
import { errorMessage } from "../utils/apiError";
import { loadCommentAuthor, saveCommentAuthor } from "../utils/commentAuthor";
import { formatTimeShort } from "../utils/time";

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
    setPlayheadSec,
    setActiveTab,
    commentMode,
    commentDraft,
    setCommentDraft,
    setCommentMode,
    selection,
    shareCapabilities,
    guestMode,
    announceStatus,
  } = useDaw();

  const [filter, setFilter] = useState<Filter>("open");
  const [author, setAuthor] = useState(loadCommentAuthor);
  const [body, setBody] = useState("");
  const [actionLine, setActionLine] = useState("");
  const [trackIds, setTrackIds] = useState<string[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const {
    busy: actionBusy,
    error: actionError,
    setError: setActionError,
    resolve,
    reply,
    toggleAction,
  } = useCommentActions({ author, setAuthor });

  const busy = createBusy || actionBusy;
  const error = createError ?? actionError;

  const toastSeq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [undoToast, setUndoToast] = useState<
    (UndoToastState & { comment: TimelineComment }) | null
  >(null);
  const dismissUndo = useCallback(() => setUndoToast(null), []);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onResolve = async (c: TimelineComment, resolved: boolean) => {
    const ok = await resolve(c, resolved);
    if (!ok) return;
    if (resolved) {
      toastSeq.current += 1;
      setUndoToast({
        id: toastSeq.current,
        message: `Resolved comment at ${commentTimeLabel(c)}`,
        comment: c,
      });
    } else {
      setUndoToast((prev) => (prev?.comment.id === c.id ? null : prev));
    }
  };

  const onUndoResolve = async () => {
    if (!undoToast) return;
    const ok = await resolve(undoToast.comment, false);
    // Skip if the panel unmounted mid-request (e.g. project switch): the
    // announcement goes to the app-wide live region and would be stale.
    if (!ok || !mounted.current) return;
    setUndoToast(null);
    announceStatus("Comment reopened");
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

  const onCreate = async () => {
    setCreateError(null);
    setActionError(null);
    const who = author.trim();
    if (!who) {
      setCreateError("Author is required");
      return;
    }
    if (!body.trim()) {
      setCreateError("Comment body is required");
      return;
    }
    const start = commentDraft?.startSec ?? 0;
    const end = commentDraft?.endSec ?? null;
    setCreateBusy(true);
    try {
      saveCommentAuthor(who);
      const actions = actionLine
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const comment = await createComment(projectPath, {
        body: body.trim(),
        author: who,
        timelineStart: start,
        timelineEnd: end,
        trackIds,
        actionTexts: actions,
      });
      setBody("");
      setActionLine("");
      setCommentDraft(null);
      if (comment) {
        setSelection({ kind: "comment", id: comment.id });
        setPlayheadSec(comment.timeline_start);
      }
      setActiveTab("comments");
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreateBusy(false);
    }
  };

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
        <label>
          Author
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="your name"
          />
        </label>
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
        <ToggleButton
          pressed={commentMode}
          onClick={() => setCommentMode(!commentMode)}
        >
          {commentMode ? "Comment mode on" : "Comment mode"}
        </ToggleButton>
      </div>

      {mayComment && (commentMode || commentDraft) && (
        <CommentCompose
          body={body}
          onBodyChange={setBody}
          busy={busy}
          submitDisabled={!commentDraft}
          onSubmit={() => void onCreate()}
          hint={
            <p className="comment-compose-hint">
              {commentDraft
                ? `Anchor: ${formatTimeShort(commentDraft.startSec)}${
                    commentDraft.endSec != null &&
                    commentDraft.endSec > commentDraft.startSec
                      ? `–${formatTimeShort(commentDraft.endSec)}`
                      : " (instant)"
                  }. Click/drag the ruler in comment mode to change.`
                : "Click the ruler for an instant, or drag for a span."}
            </p>
          }
        >
          {!guestShare && (
            <>
              <textarea
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
                      checked={trackIds.includes(t.id)}
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
                setPlayheadSec(c.timeline_start);
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
          <EmptyState as="li">No comments in this filter.</EmptyState>
        )}
      </ul>
      {guestShare ? null : (
        <UndoToast
          toast={undoToast}
          undoDisabled={busy}
          onUndo={() => void onUndoResolve()}
          onDismiss={dismissUndo}
          returnFocusRef={panelRef}
        />
      )}
    </div>
  );
}
