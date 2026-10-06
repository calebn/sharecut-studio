import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  approveEdits,
  createComment,
  rejectEdits,
  updatePendingEdit,
} from "../../api";
import {
  type PendingEditBaseline,
  pendingEditBaseline,
} from "../../api/documentEdits";
import { CommentCard, CommentCompose, useCommentActions } from "../../comments";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import {
  canComment,
  canReply,
  canRetimePendingEdit,
  canReviewPendingEdit,
  commentRole,
  isShareProjectKey,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { PendingEditView } from "../../types/project";
import { Button, DefItem, DefinitionList, FieldRow } from "../../ui";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../../utils/apiError";
import {
  resolveCommentActor,
  sessionDisplayName,
} from "../../utils/commentAuthor";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../../utils/pendingEditLabels";
import { pendingEditTimingFieldId } from "../../utils/pendingEditTimingField";
import type { PreviewMode } from "../../utils/playRange";
import { formatTimeMs, parseTimecode } from "../../utils/time";
import { ModifierInspector } from "../ModifierInspector";
import { PendingPreviewFooter } from "../PendingPreviewFooter";
import {
  REFINE_GATE_GUI_MESSAGE,
  TranscriptRefineRecovery,
} from "../TranscriptRefineRecovery";
import { usePendingCutSuggestion } from "../usePendingCutSuggestion";
import { useQueuedReviewNotice } from "../useQueuedReviewNotice";

function signedMilliseconds(value: number): string {
  return `${value >= 0 ? "+" : ""}${Number(value.toFixed(3))} ms`;
}

function exactSourceTime(seconds: number | null): string {
  if (seconds === null) return "Unavailable";
  const decimal = seconds.toString();
  const [whole = "0", fraction = ""] = decimal.split(".");
  const wholeSeconds = Number(whole);
  if (decimal.includes("e") || !Number.isSafeInteger(wholeSeconds)) {
    return `${decimal} s`;
  }
  const minutes = Math.floor(wholeSeconds / 60);
  const secondField = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${secondField}.${fraction.padEnd(3, "0")}`;
}

type TimingDraft = Readonly<{
  identity: string;
  start: string;
  end: string;
  commandId?: string;
}>;
type TimingCapture = Readonly<{
  projectPath: string;
  projectEpoch: number;
  editId: string;
  identity: string;
  expected: PendingEditBaseline;
}>;

function sourceTime(value: number | null): string {
  return value === null ? "Unavailable" : formatTimeMs(value);
}

export function PendingEditInspector({ edit }: { edit: PendingEditView }) {
  const {
    project,
    projectPath,
    projectEpoch,
    guestMode,
    shareCapabilities,
    setSelection,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    setSelection: s.setSelection,
  }));
  const canApply = canReviewPendingEdit(
    projectPath,
    guestMode,
    shareCapabilities,
    Boolean(edit.exact_range),
  );
  const canNudge =
    !edit.exact_range &&
    edit.source_start != null &&
    edit.source_end != null &&
    canRetimePendingEdit(projectPath, shareCapabilities, edit.reason);
  const mayAsk = canComment(projectPath, guestMode, shareCapabilities);
  const mayReply = canReply(projectPath, guestMode, shareCapabilities);
  const { busy, error, errorCode, setError, run } = useProjectMutation();
  const {
    notice: queuedNotice,
    queued,
    checking: checkingQueue,
    settlement,
    setQueued,
  } = useQueuedReviewNotice(projectPath, edit.id);
  const isSplit = edit.type === "split";
  const canSuggestBounds =
    canNudge &&
    !edit.applied &&
    (edit.type === "remove" || edit.type === "mute") &&
    (edit.timebase == null || edit.timebase === "source");
  const suggestion = usePendingCutSuggestion(
    edit,
    canSuggestBounds && !queued && !checkingQueue,
  );
  const timingBusy = busy || queued || checkingQueue;
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    edit.suggest_reason ? "current" : "suggested",
  );
  const [snapToSilence, setSnapToSilence] = useState(true);
  const [startStr, setStartStr] = useState(sourceTime(edit.source_start));
  const [endStr, setEndStr] = useState(sourceTime(edit.source_end));
  const [tracksStr, setTracksStr] = useState(
    (edit.track_ids ?? [edit.track_id]).join(", "),
  );
  const timingIdentity = JSON.stringify([
    projectPath,
    projectEpoch,
    edit.id,
    edit.track_id,
    edit.type,
    edit.timebase ?? "source",
  ]);
  const previousTiming = useRef({
    identity: timingIdentity,
    start: edit.source_start,
    end: edit.source_end,
  });
  const submittedTiming = useRef<TimingDraft | null>(null);
  const timingDirty =
    startStr.trim() !== sourceTime(edit.source_start) ||
    endStr.trim() !== sourceTime(edit.source_end);
  const suggestionHintId = useId();
  const role = commentRole(projectPath, guestMode);
  const [author, setAuthor] = useState(() => sessionDisplayName(role));
  const [askBody, setAskBody] = useState("");
  const timeHintId = useId();
  const {
    busy: threadBusy,
    error: threadError,
    setError: setThreadError,
    resolve,
    reply,
  } = useCommentActions({ role, author, setAuthor });

  const thread = useMemo(
    () =>
      (project?.comments ?? []).find((c) => c.edit_decision_id === edit.id) ??
      null,
    [project?.comments, edit.id],
  );

  useEffect(() => {
    setError(null);
    setQueued(false);
  }, [timingIdentity, setError, setQueued]);

  useEffect(() => {
    const previous = previousTiming.current;
    const submitted = submittedTiming.current;
    const sameIdentity = previous.identity === timingIdentity;
    const boundsChanged =
      previous.start !== edit.source_start || previous.end !== edit.source_end;
    setStartStr((text) =>
      !sameIdentity ||
      text.trim() === sourceTime(previous.start) ||
      (boundsChanged &&
        submitted?.identity === timingIdentity &&
        !submitted.commandId &&
        text === submitted.start)
        ? sourceTime(edit.source_start)
        : text,
    );
    setEndStr((text) =>
      !sameIdentity ||
      text.trim() === sourceTime(previous.end) ||
      (boundsChanged &&
        submitted?.identity === timingIdentity &&
        !submitted.commandId &&
        text === submitted.end)
        ? sourceTime(edit.source_end)
        : text,
    );
    previousTiming.current = {
      identity: timingIdentity,
      start: edit.source_start,
      end: edit.source_end,
    };
    if (!sameIdentity || (boundsChanged && !submitted?.commandId))
      submittedTiming.current = null;
    setTracksStr((edit.track_ids ?? [edit.track_id]).join(", "));
    if (!sameIdentity) {
      setAskBody("");
      setSnapToSilence(true);
    }
    setPreviewMode(edit.suggest_reason ? "current" : "suggested");
  }, [
    timingIdentity,
    edit.id,
    edit.source_start,
    edit.source_end,
    edit.track_id,
    edit.track_ids,
    edit.suggest_reason,
  ]);

  useEffect(() => {
    const draft = submittedTiming.current;
    if (
      !settlement ||
      !draft ||
      draft.identity !== timingIdentity ||
      draft.commandId !== settlement.commandId
    )
      return;
    if (settlement.outcome === "applied") {
      setStartStr((text) =>
        text === draft.start ? sourceTime(edit.source_start) : text,
      );
      setEndStr((text) =>
        text === draft.end ? sourceTime(edit.source_end) : text,
      );
    }
    submittedTiming.current = null;
  }, [settlement, timingIdentity, edit.source_start, edit.source_end]);

  const runAction = async (action: "approve" | "reject") => {
    if (timingBusy) return;
    const live = useDawStore.getState();
    const currentEdit = live.project?.pending_edits.find(
      (item) => item.id === edit.id,
    );
    if (
      live.projectPath !== projectPath ||
      live.projectEpoch !== projectEpoch ||
      !currentEdit ||
      !canReviewPendingEdit(
        live.projectPath,
        live.guestMode,
        live.shareCapabilities,
        Boolean(currentEdit.exact_range),
      )
    )
      return;
    const selection = live.selection;
    setQueued(false);
    await run(async () => {
      const { queued } =
        action === "approve"
          ? await approveEdits(projectPath, [edit.id])
          : await rejectEdits(projectPath, [edit.id]);
      const current = useDawStore.getState();
      if (
        current.projectPath !== projectPath ||
        current.projectEpoch !== projectEpoch ||
        previousTiming.current.identity !== timingIdentity ||
        current.selection !== selection
      )
        return;
      if (queued) {
        // Saved but not sent yet: keep the edit selected and say so.
        setQueued(true);
        return;
      }
      const next = useDawStore.getState().project;
      const stillThere = next?.pending_edits.some((e) => e.id === edit.id);
      if (!stillThere) {
        setSelection(null);
      }
    });
  };

  const currentTimingEdit = (capture: TimingCapture) => {
    const current = useDawStore.getState();
    const saved = current.project?.pending_edits.find(
      (item) => item.id === capture.editId,
    );
    return previousTiming.current.identity === capture.identity &&
      current.projectPath === capture.projectPath &&
      current.projectEpoch === capture.projectEpoch &&
      saved?.applied === false &&
      saved.track_id === capture.expected.track_id &&
      saved.type === capture.expected.type &&
      (saved.timebase ?? "source") === capture.expected.timebase
      ? saved
      : null;
  };

  const captureTiming = (): TimingCapture | null => {
    const current = useDawStore.getState();
    const saved = current.project?.pending_edits.find(
      (item) => item.id === edit.id,
    );
    if (
      !saved ||
      saved.exact_range ||
      saved.source_start == null ||
      saved.source_end == null
    )
      return null;
    const capture: TimingCapture = {
      projectPath,
      projectEpoch,
      editId: edit.id,
      identity: timingIdentity,
      expected: pendingEditBaseline(saved),
    };
    return currentTimingEdit(capture) &&
      saved.track_id === edit.track_id &&
      saved.type === edit.type &&
      (saved.timebase ?? "source") === (edit.timebase ?? "source") &&
      saved.source_start === edit.source_start &&
      saved.source_end === edit.source_end
      ? capture
      : null;
  };

  const saveTiming = async ({
    capture,
    start,
    end,
    snap,
    trackIds,
    draft,
  }: {
    capture: TimingCapture;
    start: number;
    end: number;
    snap: boolean;
    trackIds?: string[];
    draft?: TimingDraft;
  }) => {
    await run(async () => {
      try {
        const result = await updatePendingEdit(
          capture.projectPath,
          capture.editId,
          start,
          end,
          snap,
          trackIds,
          capture.expected,
        );
        const saved = currentTimingEdit(capture);
        if (!saved) return;
        if (result.queued && draft && submittedTiming.current === draft) {
          submittedTiming.current = { ...draft, commandId: result.commandId };
        }
        setQueued(result.queued, result.queued ? result.commandId : undefined);
        if (!result.queued && draft) {
          setStartStr((text) =>
            text === draft.start ? sourceTime(saved.source_start) : text,
          );
          setEndStr((text) =>
            text === draft.end ? sourceTime(saved.source_end) : text,
          );
          if (submittedTiming.current === draft) submittedTiming.current = null;
        }
      } catch (error) {
        if (submittedTiming.current === draft) submittedTiming.current = null;
        if (currentTimingEdit(capture)) throw error;
      }
    });
  };

  const applyNudge = async () => {
    if (timingBusy) return;
    const capture = captureTiming();
    if (!capture) return;
    // An untouched field sends the stored time, not its ms-rounded text.
    const fieldSec = (text: string, stored: number) =>
      text.trim() === formatTimeMs(stored) ? stored : parseTimecode(text);
    const start = fieldSec(startStr, capture.expected.start);
    const end = isSplit ? start : fieldSec(endStr, capture.expected.end);
    if (start == null || end == null) {
      setError("Times must be m:ss.mmm or seconds");
      return;
    }
    if (!isSplit && end <= start) {
      setError("Source start/end must be valid with end > start");
      return;
    }
    const trackIds = tracksStr
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const draft: TimingDraft = {
      identity: timingIdentity,
      start: startStr,
      end: endStr,
    };
    submittedTiming.current = draft;
    await saveTiming({
      capture,
      start,
      end,
      snap: !isSplit && snapToSilence,
      trackIds: isSplit ? trackIds : undefined,
      draft,
    });
  };

  const recheckSnap = async (checked: boolean) => {
    if (timingBusy) return;
    setSnapToSilence(checked);
    if (!checked || snapToSilence) return;
    const capture = captureTiming();
    if (!capture) return;
    await saveTiming({
      capture,
      start: capture.expected.start,
      end: capture.expected.end,
      snap: true,
    });
  };

  const acceptSuggestion = async () => {
    if (timingDirty || timingBusy) return;
    const proposal = suggestion.currentProposal();
    const capture = captureTiming();
    if (!proposal || !capture) return;
    await saveTiming({
      capture: { ...capture, expected: proposal.expected },
      start: proposal.suggested.start,
      end: proposal.suggested.end,
      snap: false,
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
      if (tlStart == null || tlEnd == null)
        throw new Error("This edit has no timeline position.");
      await createComment(projectPath, {
        body: text,
        author: resolveCommentActor(author, role),
        timelineStart: tlStart,
        timelineEnd: tlEnd,
        trackIds: edit.track_ids ?? [edit.track_id],
        timelineSpans: edit.exact_range?.intervals,
        editDecisionId: edit.id,
      });
      setAskBody("");
    });
  };

  const tlStart = edit.timeline_start ?? edit.source_start;
  const combinedError = error ?? threadError;

  return (
    <ModifierInspector
      badge="Pending"
      title={
        edit.exact_range
          ? `Pending ${pendingTypeLabel(edit.type).toLowerCase()}`
          : isSplit
            ? "Pending split"
            : "Pending edit"
      }
      subtitle={pendingReasonLabel(edit.reason)}
      primaryActions={
        canApply || edit.exact_range
          ? [
              {
                label: "Approve",
                variant: "primary" as const,
                disabled: timingBusy || !canApply,
                title: !canApply
                  ? "Only the host can review exact range proposals"
                  : undefined,
                onClick: () => void runAction("approve"),
              },
              {
                label: "Reject",
                variant: "danger" as const,
                disabled: timingBusy || !canApply,
                title: !canApply
                  ? "Only the host can review exact range proposals"
                  : undefined,
                onClick: () => void runAction("reject"),
              },
            ]
          : undefined
      }
      error={
        error && errorCode === TRANSCRIPT_REFINE_REQUIRED_CODE
          ? REFINE_GATE_GUI_MESSAGE
          : combinedError
      }
      footer={
        tlStart != null ? (
          <PendingPreviewFooter
            edit={edit}
            projectPath={projectPath}
            seekSec={tlStart}
            mode={previewMode}
            onModeChange={setPreviewMode}
            onError={setThreadError}
          />
        ) : undefined
      }
    >
      {edit.exact_range && !canApply ? (
        <p className="ui-field-hint">
          Only the host can review exact range proposals.
        </p>
      ) : null}
      <DefinitionList>
        {!edit.exact_range ? (
          <DefItem label="Type">{pendingTypeLabel(edit.type)}</DefItem>
        ) : null}
        {edit.exact_range ? (
          <>
            <DefItem label="Timeline islands">
              {edit.exact_range.intervals
                .map((r) => `${formatTimeMs(r.start)} – ${formatTimeMs(r.end)}`)
                .join(" · ")}
            </DefItem>
            <DefItem label="Tracks">
              {edit.exact_range.track_ids.join(", ")}
            </DefItem>
          </>
        ) : isSplit ? (
          <>
            <DefItem label="Cut time (timeline)">
              {canNudge ? (
                <FieldRow>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="m:ss.mmm"
                    value={startStr}
                    disabled={timingBusy}
                    aria-label="Cut time"
                    aria-describedby={timeHintId}
                    onChange={(e) => setStartStr(e.target.value)}
                  />
                  <span id={timeHintId} className="ui-field-hint">
                    m:ss.mmm or seconds
                  </span>
                  <Button
                    disabled={timingBusy}
                    onClick={() => void applyNudge()}
                  >
                    Apply
                  </Button>
                </FieldRow>
              ) : (
                sourceTime(edit.source_start)
              )}
            </DefItem>
            <DefItem label="Tracks">
              {canNudge ? (
                <FieldRow>
                  <input
                    type="text"
                    value={tracksStr}
                    disabled={timingBusy}
                    aria-label="Track ids"
                    onChange={(e) => setTracksStr(e.target.value)}
                  />
                  <Button
                    disabled={timingBusy}
                    onClick={() => void applyNudge()}
                  >
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
                  id={pendingEditTimingFieldId(edit.id, "start")}
                  className="pending-source-time-field"
                  type="text"
                  spellCheck={false}
                  placeholder="m:ss.mmm"
                  value={startStr}
                  disabled={timingBusy}
                  aria-label="Source start"
                  aria-describedby={timeHintId}
                  onChange={(e) => setStartStr(e.target.value)}
                />
                <span>–</span>
                <input
                  id={pendingEditTimingFieldId(edit.id, "end")}
                  className="pending-source-time-field"
                  type="text"
                  spellCheck={false}
                  placeholder="m:ss.mmm"
                  value={endStr}
                  disabled={timingBusy}
                  aria-label="Source end"
                  aria-describedby={timeHintId}
                  onChange={(e) => setEndStr(e.target.value)}
                />
                <span id={timeHintId} className="ui-field-hint">
                  m:ss.mmm or seconds
                </span>
                <label className="pending-snap-option">
                  <input
                    type="checkbox"
                    checked={snapToSilence}
                    disabled={timingBusy}
                    onChange={(event) =>
                      void recheckSnap(event.currentTarget.checked)
                    }
                  />
                  Snap to silence
                </label>
                <Button
                  className="pending-source-time-apply"
                  disabled={timingBusy}
                  onClick={() => void applyNudge()}
                >
                  Apply timing
                </Button>
              </FieldRow>
            ) : (
              `${sourceTime(edit.source_start)} – ${sourceTime(edit.source_end)}`
            )}
          </DefItem>
        )}
        {!isSplit && !edit.exact_range ? (
          <DefItem label="Timeline">
            {edit.mappable && edit.timeline_start != null
              ? `${formatTimeMs(edit.timeline_start)} – ${formatTimeMs(edit.timeline_end ?? edit.timeline_start)}`
              : "Not mappable (cut away)"}
          </DefItem>
        ) : null}
        {edit.crossfade_ms != null && !isSplit && !edit.exact_range ? (
          <DefItem label="Join fade">{edit.crossfade_ms} ms</DefItem>
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
      {canSuggestBounds ? (
        <section
          className="pending-cut-suggestion"
          aria-label="Suggested bounds"
        >
          <h3>Suggested bounds</h3>
          <DefinitionList>
            <DefItem label="Original source">
              {exactSourceTime(edit.source_start)} to{" "}
              {exactSourceTime(edit.source_end)}
            </DefItem>
            {suggestion.state?.kind === "ready" ? (
              <>
                <DefItem label="Suggested source">
                  {exactSourceTime(suggestion.state.proposal.suggested.start)}{" "}
                  to {exactSourceTime(suggestion.state.proposal.suggested.end)}
                </DefItem>
                <DefItem label="Start shift">
                  {signedMilliseconds(suggestion.state.proposal.startShiftMs)}
                </DefItem>
                <DefItem label="End shift">
                  {signedMilliseconds(suggestion.state.proposal.endShiftMs)}
                </DefItem>
                <DefItem label="Edit duration change">
                  {signedMilliseconds(
                    suggestion.state.proposal.durationDeltaMs,
                  )}
                </DefItem>
              </>
            ) : null}
          </DefinitionList>
          {suggestion.state?.kind === "unavailable" ? (
            <>
              <p className="ui-field-hint">
                Suggestion unavailable. {suggestion.state.message}
              </p>
              <Button disabled={timingBusy} onClick={suggestion.retry}>
                Retry suggestion
              </Button>
            </>
          ) : !queued && suggestion.state?.kind !== "ready" ? (
            <p className="ui-field-hint">Loading suggested bounds…</p>
          ) : null}
          {timingDirty ? (
            <p id={suggestionHintId} className="ui-field-hint">
              Apply timing first to review a suggestion for your changes.
            </p>
          ) : null}
          <Button
            disabled={
              timingBusy || timingDirty || suggestion.state?.kind !== "ready"
            }
            aria-describedby={timingDirty ? suggestionHintId : undefined}
            onClick={() => void acceptSuggestion()}
          >
            Use suggestion
          </Button>
        </section>
      ) : null}
      {queuedNotice}
      {!isShareProjectKey(projectPath) ? (
        <TranscriptRefineRecovery
          key={edit.id}
          projectPath={projectPath}
          error={error}
          errorCode={errorCode}
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
