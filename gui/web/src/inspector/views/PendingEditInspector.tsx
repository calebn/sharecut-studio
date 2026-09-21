import { useEffect, useMemo, useState } from "react";
import {
  approveEdits,
  createComment,
  rejectEdits,
  updatePendingEdit,
} from "../../api";
import { CommentCard, CommentCompose, useCommentActions } from "../../comments";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import {
  canApplyPass12,
  canComment,
  canReply,
  canSuggestOrNudge,
  isShareProjectKey,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { PendingEditView } from "../../types/project";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import { loadCommentAuthor } from "../../utils/commentAuthor";
import {
  canSuggestSkip,
  type PreviewMode,
  suggestDisabledReason,
} from "../../utils/playRange";
import { ModifierInspector } from "../ModifierInspector";
import { TranscriptRefineRecovery } from "../TranscriptRefineRecovery";

export function PendingEditInspector({ edit }: { edit: PendingEditView }) {
  const { project, projectPath, guestMode, shareCapabilities, setSelection } =
    useDaw();
  const canApply = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const canNudge = canSuggestOrNudge(projectPath, guestMode, shareCapabilities);
  const mayAsk = canComment(projectPath, guestMode, shareCapabilities);
  const mayReply = canReply(projectPath, guestMode, shareCapabilities);
  const { busy, error, setError, run } = useProjectMutation();
  const isSplit = edit.type === "split";
  const skipOk = canSuggestSkip(edit);
  const skipReason = suggestDisabledReason(edit);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    skipOk ? "suggested" : "current",
  );
  const [startStr, setStartStr] = useState(String(edit.source_start));
  const [endStr, setEndStr] = useState(String(edit.source_end));
  const [tracksStr, setTracksStr] = useState(
    (edit.track_ids ?? [edit.track_id]).join(", "),
  );
  const [author, setAuthor] = useState(loadCommentAuthor);
  const [askBody, setAskBody] = useState("");
  const {
    busy: threadBusy,
    error: threadError,
    setError: setThreadError,
    resolve,
    reply,
  } = useCommentActions({ author, setAuthor });

  const thread = useMemo(
    () =>
      (project?.comments ?? []).find((c) => c.edit_decision_id === edit.id) ??
      null,
    [project?.comments, edit.id],
  );

  useEffect(() => {
    setError(null);
  }, [edit.id, setError]);

  useEffect(() => {
    setStartStr(String(edit.source_start));
    setEndStr(String(edit.source_end));
    setTracksStr((edit.track_ids ?? [edit.track_id]).join(", "));
    setAskBody("");
    setPreviewMode(
      canSuggestSkip({
        type: edit.type,
        scope: edit.scope,
        mappable: edit.mappable,
        timeline_start: edit.timeline_start,
        timeline_end: edit.timeline_end,
      })
        ? "suggested"
        : "current",
    );
  }, [
    edit.id,
    edit.source_start,
    edit.source_end,
    edit.track_id,
    edit.track_ids,
    edit.type,
    edit.scope,
    edit.mappable,
    edit.timeline_start,
    edit.timeline_end,
  ]);

  const runAction = async (action: "approve" | "reject") => {
    await run(async () => {
      if (action === "approve") {
        await approveEdits(projectPath, [edit.id]);
      } else {
        await rejectEdits(projectPath, [edit.id]);
      }
      const next = useDawStore.getState().project;
      const stillThere = next?.pending_edits.some((e) => e.id === edit.id);
      if (!stillThere) {
        setSelection(null);
      }
    });
  };

  const applyNudge = async () => {
    const start = Number.parseFloat(startStr);
    const end = isSplit ? start : Number.parseFloat(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError("Times must be valid numbers");
      return;
    }
    if (!isSplit && end <= start) {
      setError("Source start/end must be valid with end > start");
      return;
    }
    const trackIds = tracksStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await run(async () => {
      await updatePendingEdit(
        projectPath,
        edit.id,
        start,
        end,
        !isSplit,
        isSplit ? trackIds : undefined,
      );
    });
  };

  const postAsk = async () => {
    const text = askBody.trim();
    if (!text) {
      setThreadError("Ask body is required");
      return;
    }
    setThreadError(null);
    await run(async () => {
      if (thread) {
        const ok = await reply(thread, text);
        if (ok) {
          setAskBody("");
        }
        return;
      }
      const tlStart = edit.timeline_start ?? edit.source_start;
      const tlEnd = isSplit ? tlStart : (edit.timeline_end ?? edit.source_end);
      await createComment(projectPath, {
        body: text,
        author: author.trim() || "viewer",
        timelineStart: tlStart,
        timelineEnd: tlEnd,
        trackIds: edit.track_ids ?? [edit.track_id],
        editDecisionId: edit.id,
      });
      setAskBody("");
    });
  };

  const tlStart = edit.timeline_start ?? edit.source_start;
  const tlEnd = edit.timeline_end ?? edit.source_end;
  const combinedError = error ?? threadError;

  return (
    <ModifierInspector
      badge="Pending"
      title={isSplit ? "Pending split" : "Pending edit"}
      subtitle={edit.reason ?? edit.type}
      primaryActions={
        canApply
          ? [
              {
                label: "Approve",
                variant: "primary" as const,
                disabled: busy,
                onClick: () => void runAction("approve"),
              },
              {
                label: "Reject",
                variant: "danger" as const,
                disabled: busy,
                onClick: () => void runAction("reject"),
              },
            ]
          : undefined
      }
      error={combinedError}
      footer={
        <InspectorSeekFooter
          seekSec={tlStart}
          playStart={tlStart}
          playEnd={isSplit ? tlStart : tlEnd}
          previewMode={previewMode}
          onPreviewModeChange={setPreviewMode}
          suggestDisabled={!skipOk}
          suggestDisabledReason={skipReason}
        />
      }
    >
      <DefinitionList>
        <DefItem label="Type">{edit.type}</DefItem>
        <DefItem label="Reason">{edit.reason ?? "—"}</DefItem>
        {isSplit ? (
          <>
            <DefItem label="Cut time (timeline)">
              {canNudge ? (
                <FieldRow>
                  <input
                    type="number"
                    step="0.01"
                    value={startStr}
                    disabled={busy}
                    aria-label="Cut time"
                    onChange={(e) => setStartStr(e.target.value)}
                  />
                  <Button disabled={busy} onClick={() => void applyNudge()}>
                    Apply
                  </Button>
                </FieldRow>
              ) : (
                `${edit.source_start.toFixed(3)} s`
              )}
            </DefItem>
            <DefItem label="Tracks">
              {canNudge ? (
                <FieldRow>
                  <input
                    type="text"
                    value={tracksStr}
                    disabled={busy}
                    aria-label="Track ids"
                    onChange={(e) => setTracksStr(e.target.value)}
                  />
                  <Button disabled={busy} onClick={() => void applyNudge()}>
                    Apply tracks
                  </Button>
                </FieldRow>
              ) : (
                (edit.track_ids ?? [edit.track_id]).join(", ")
              )}
            </DefItem>
          </>
        ) : (
          <DefItem label="Source">
            {canNudge ? (
              <FieldRow>
                <input
                  type="number"
                  step="0.01"
                  value={startStr}
                  disabled={busy}
                  aria-label="Source start"
                  onChange={(e) => setStartStr(e.target.value)}
                />
                <span>–</span>
                <input
                  type="number"
                  step="0.01"
                  value={endStr}
                  disabled={busy}
                  aria-label="Source end"
                  onChange={(e) => setEndStr(e.target.value)}
                />
                <Button disabled={busy} onClick={() => void applyNudge()}>
                  Snap &amp; apply
                </Button>
              </FieldRow>
            ) : (
              `${edit.source_start.toFixed(3)} – ${edit.source_end.toFixed(3)} s`
            )}
          </DefItem>
        )}
        {!isSplit ? (
          <DefItem label="Timeline">
            {edit.mappable && edit.timeline_start != null
              ? `${edit.timeline_start.toFixed(3)} – ${edit.timeline_end?.toFixed(3)} s`
              : "Not mappable (cut away)"}
          </DefItem>
        ) : null}
        {edit.crossfade_ms != null && !isSplit ? (
          <DefItem label="Crossfade">{edit.crossfade_ms} ms</DefItem>
        ) : null}
        {edit.boundary_mode ? (
          <DefItem label="Boundary">{edit.boundary_mode}</DefItem>
        ) : null}
        <DefItem label="Review">
          {edit.review_required ? "required" : "no"}
        </DefItem>
        {edit.cut_confidence != null ? (
          <DefItem label="Confidence">{edit.cut_confidence.toFixed(2)}</DefItem>
        ) : null}
      </DefinitionList>
      {!isShareProjectKey(projectPath) ? (
        <TranscriptRefineRecovery
          key={edit.id}
          projectPath={projectPath}
          error={error}
          onRecovered={() => setError(null)}
        />
      ) : null}
      <section className="pending-ask-thread" aria-label="Ask about this edit">
        <h3>Ask</h3>
        {thread ? (
          <ul className="pending-ask-list">
            <CommentCard
              comment={thread}
              guestShare={!canApply}
              showResolve={canApply}
              showReply={false}
              showActions={canApply}
              onResolve={(resolved) => void resolve(thread, resolved)}
            />
          </ul>
        ) : (
          <p className="inspector-body">
            Hear Suggested, then approve, reject, or ask a question in this
            thread.
          </p>
        )}
        {(thread ? mayReply : mayAsk) ? (
          <CommentCompose
            body={askBody}
            onBodyChange={setAskBody}
            busy={busy || threadBusy}
            submitLabel={thread ? "Reply" : "Ask"}
            bodyPlaceholder={
              thread ? "Reply…" : "Ask for more context before deciding…"
            }
            onSubmit={() => void postAsk()}
            author={author}
            onAuthorChange={setAuthor}
          />
        ) : null}
      </section>
    </ModifierInspector>
  );
}
