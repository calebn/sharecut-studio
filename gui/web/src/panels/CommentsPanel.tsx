import { useCallback, useMemo, useRef, useState } from "react";
import {
  CommentAnchorChip,
  CommentAuthorLine,
  CommentCard,
  CommentCompose,
  commentTimeLabel,
  useCommentActions,
  usePostComment,
} from "../comments";
import { useMountedRef } from "../hooks/useMountedRef";
import { canComment, canReply, canSetAction, commentRole } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TimelineComment } from "../types/project";
import {
  EmptyState,
  InlineError,
  SegmentedControl,
  Toast,
  type ToastState,
  ToggleButton,
} from "../ui";
import { saveCommentAuthor, sessionDisplayName } from "../utils/commentAuthor";

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
    setCommentMode,
    selection,
    shareCapabilities,
    guestMode,
    announceStatus,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    setSelection: s.setSelection,
    setPlayheadSec: s.setPlayheadSec,
    setActiveTab: s.setActiveTab,
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
  const [author, setAuthor] = useState(() => sessionDisplayName(role));
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
  } = useCommentActions({ role, author, setAuthor });

  const busy = createBusy || actionBusy;
  const error = createError ?? actionError;

  const toastSeq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [undoToast, setUndoToast] = useState<
    (ToastState & { comment: TimelineComment }) | null
  >(null);
  const dismissUndo = useCallback(() => setUndoToast(null), []);
  const mounted = useMountedRef();

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
    // Unmount disposes the panel-local toast, but cannot cancel this mutation.
    // Suppress its later app-wide announcement. Revisit if toast ownership moves.
    if (!ok || !mounted.current) return;
    setUndoToast(null);
    // The reopened card is the visual twin; a second toast would cover the panel's.
    announceStatus("Comment reopened", { toast: false });
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
    setActionError(null);
    const result = await post({
      body,
      author,
      trackIds,
      actionTexts: actionLine
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    });
    if (!result.ok) return;
    setBody("");
    setActionLine("");
    if (result.comment) {
      setSelection({ kind: "comment", id: result.comment.id });
      setPlayheadSec(result.comment.timeline_start);
    }
    setActiveTab("comments");
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
        <CommentAuthorLine
          name={author}
          onChange={(next) => {
            setAuthor(next);
            saveCommentAuthor(next);
          }}
        />
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
            {commentMode ? "Comment mode on" : "Comment mode"}
          </ToggleButton>
        ) : null}
      </div>

      {mayComment && (
        <CommentCompose
          body={body}
          onBodyChange={setBody}
          busy={busy}
          onSubmit={() => void onCreate()}
          anchor={<CommentAnchorChip />}
          bodyPlaceholder="Add a comment…"
          bodyRows={2}
        >
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
        <Toast
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
