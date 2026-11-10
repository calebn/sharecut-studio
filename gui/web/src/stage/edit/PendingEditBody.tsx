import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  pendingOffersCut,
  registerPendingDecider,
} from "../../commands/pendingDecision";
import { useCommentActions } from "../../comments";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { TrackToggleRow } from "../../inspector/TrackToggleRow";
import {
  REFINE_GATE_GUI_MESSAGE,
  TranscriptRefineRecovery,
} from "../../inspector/TranscriptRefineRecovery";
import { useQueuedReviewNotice } from "../../inspector/useQueuedReviewNotice";
import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import { decisionKindOf } from "../../review/reviewItems";
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
import { CommentCard } from "../../system/CommentCard";
import { Composer } from "../../system/Composer";
import { DecisionCard } from "../../system/DecisionCard";
import { ScrubField } from "../../system/ScrubField";
import { formatSeconds } from "../../system/seconds";
import { snapActive } from "../../timeline/snapOverlay";
import type { PendingEditView } from "../../types/project";
import { InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import {
  errorMessage,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../../utils/apiError";
import {
  resolveCommentActor,
  sessionDisplayName,
} from "../../utils/commentAuthor";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../../utils/pendingEditLabels";
import { pendingEditTimingFieldId } from "../../utils/pendingEditTimingField";
import {
  capturePendingReview,
  finishPendingReview,
} from "../../utils/pendingReviewPass";
import type { PreviewMode } from "../../utils/playRange";
import { formatTimeMs } from "../../utils/time";
import { commentCardOf } from "../hosts/commentCardData";
import { PendingPreview } from "./PendingPreview";
import { usePendingEditWarm } from "./usePendingEditWarm";

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

/** Warms and releases this edit's previews without re-rendering the body on mix changes. */
function PendingWarm({
  projectPath,
  editId,
}: {
  projectPath: string;
  editId: string;
}) {
  usePendingEditWarm(projectPath, editId, true);
  return null;
}

export function PendingEditBody({
  edit,
  verbsOnBar = false,
}: {
  edit: PendingEditView;
  verbsOnBar?: boolean;
}) {
  const {
    project,
    projectPath,
    projectEpoch,
    guestMode,
    shareCapabilities,
    shareAuthor,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    shareAuthor: s.shareAuthor,
  }));
  const canApply = canReviewPendingEdit(projectPath, shareCapabilities);
  const canNudge =
    !edit.exact_range &&
    edit.source_start != null &&
    edit.source_end != null &&
    canRetimePendingEdit(
      projectPath,
      shareCapabilities,
      shareAuthor,
      edit.author,
    );
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
  const timingBusy = busy || queued || checkingQueue;
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    edit.suggest_reason ? "current" : "suggested",
  );
  const altHeld = useRef(false);
  useEffect(() => {
    const follow = (event: KeyboardEvent | PointerEvent) => {
      altHeld.current = event.altKey;
    };
    const release = () => {
      altHeld.current = false;
    };
    const events = ["keydown", "keyup", "pointerdown", "pointerup"] as const;
    for (const name of events) window.addEventListener(name, follow, true);
    window.addEventListener("blur", release);
    return () => {
      for (const name of events) window.removeEventListener(name, follow, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  const [enteredEdge, setEnteredEdge] = useState<Readonly<{
    edge: "start" | "end";
    value: number;
    commandId: string;
  }> | null>(null);
  const timingIdentity = JSON.stringify([
    projectPath,
    projectEpoch,
    edit.id,
    edit.track_id,
    edit.type,
    edit.timebase ?? "source",
  ]);
  const previousTiming = useRef({ identity: timingIdentity });
  const role = commentRole(projectPath, guestMode);
  const [author, setAuthor] = useState(() => sessionDisplayName(role));
  const [askBody, setAskBody] = useState("");
  const replyField = useRef<HTMLTextAreaElement | null>(null);
  const focusReplyOnMount = useRef(false);
  const setReplyField = useCallback((node: HTMLTextAreaElement | null) => {
    replyField.current = node;
    if (node && focusReplyOnMount.current) {
      focusReplyOnMount.current = false;
      node.focus();
    }
  }, []);
  useEffect(() => {
    focusReplyOnMount.current = false;
  }, [edit.id]);
  const {
    busy: threadBusy,
    error: threadError,
    setError: setThreadError,
    resolve,
    reply,
    toggleAction,
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
    const sameIdentity = previousTiming.current.identity === timingIdentity;
    previousTiming.current = { identity: timingIdentity };
    if (!sameIdentity) {
      setAskBody("");
    }
    setPreviewMode(edit.suggest_reason ? "current" : "suggested");
  }, [timingIdentity, edit.id, edit.suggest_reason]);

  const runAction = async (
    action: "approve" | "reject",
    fromBar = false,
  ): Promise<string | null> => {
    if (timingBusy) return BUSY_REASON;
    const live = useDawStore.getState();
    const currentEdit = live.project?.pending_edits.find(
      (item) => item.id === edit.id,
    );
    if (
      live.projectPath !== projectPath ||
      live.projectEpoch !== projectEpoch ||
      !currentEdit
    )
      return "That suggestion is gone";
    if (!canReviewPendingEdit(live.projectPath, live.shareCapabilities))
      return "This link cannot decide suggestions";
    const selection = live.selection;
    const capture = capturePendingReview(action, projectPath, currentEdit);
    setQueued(false);
    await run(async () => {
      let outcome: Awaited<ReturnType<typeof approveEdits>>;
      try {
        outcome =
          action === "approve"
            ? await approveEdits(projectPath, [edit.id], false, true)
            : await rejectEdits(projectPath, [edit.id]);
      } catch (error) {
        if (fromBar)
          useDawStore
            .getState()
            .announceStatus(errorMessage(error), { tone: "error" });
        throw error;
      }
      const current = useDawStore.getState();
      if (
        current.projectPath !== projectPath ||
        current.projectEpoch !== projectEpoch ||
        previousTiming.current.identity !== timingIdentity ||
        current.selection !== selection
      )
        return;
      if (outcome.queued) {
        // Saved but not sent yet: keep the edit selected and say so.
        setQueued(true);
        if (fromBar) finishPendingReview(capture, outcome);
        return;
      }
      finishPendingReview(capture, outcome);
    });
    return null;
  };

  useEffect(() => {
    if (
      enteredEdge &&
      settlement &&
      settlement.commandId === enteredEdge.commandId &&
      settlement.outcome === "applied"
    )
      setEnteredEdge(null);
  }, [settlement, enteredEdge]);

  useEffect(() => {
    setEnteredEdge(null);
  }, [timingIdentity, edit.source_start, edit.source_end]);

  const busyRef = useRef(timingBusy);
  useLayoutEffect(() => {
    busyRef.current = timingBusy;
  });
  const decideRef = useRef(runAction);
  useLayoutEffect(() => {
    decideRef.current = runAction;
  });
  useEffect(
    () =>
      registerPendingDecider(
        edit.id,
        (action) => decideRef.current(action, true),
        () => (busyRef.current ? BUSY_REASON : null),
      ),
    [edit.id],
  );

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
    entered,
  }: {
    capture: TimingCapture;
    start: number;
    end: number;
    snap: boolean;
    trackIds?: string[];
    entered?: Readonly<{ edge: "start" | "end"; value: number }>;
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
        if (!currentTimingEdit(capture)) return;
        setQueued(result.queued, result.queued ? result.commandId : undefined);
        setEnteredEdge(
          result.queued && entered
            ? { ...entered, commandId: result.commandId }
            : null,
        );
      } catch (error) {
        if (currentTimingEdit(capture)) throw error;
      }
    });
  };

  // A split has one time and a set of tracks, each saved as it is set.
  const commitSplit = async (value: number | null, trackIds?: string[]) => {
    if (timingBusy) return;
    const capture = captureTiming();
    if (!capture) return;
    const start = value ?? capture.expected.start;
    await saveTiming({ capture, start, end: start, snap: false, trackIds });
  };

  const commitEdge = async (edge: "start" | "end", value: number) => {
    const snap = snapActive(
      useDawStore.getState().snapEnabled,
      altHeld.current,
    );
    altHeld.current = false;
    if (timingBusy) return;
    const capture = captureTiming();
    if (!capture) return;
    const start = edge === "start" ? value : capture.expected.start;
    const end = edge === "end" ? value : capture.expected.end;
    if (end <= start) {
      setError("Source start/end must be valid with end > start");
      return;
    }
    await saveTiming({
      capture,
      start,
      end,
      snap,
      entered: { edge, value },
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
      if (replyField.current) replyField.current.focus();
      else if (mayReply) focusReplyOnMount.current = true;
    });
  };

  const tlStart = edit.timeline_start ?? edit.source_start;
  const combinedError = error ?? threadError;

  const title = edit.exact_range
    ? `Pending ${pendingTypeLabel(edit.type).toLowerCase()}`
    : isSplit
      ? "Pending split"
      : "Pending edit";
  const shownEdge = (edge: "start" | "end") =>
    enteredEdge?.edge === edge
      ? enteredEdge.value
      : edge === "start"
        ? edit.source_start
        : edit.source_end;
  const speaker = project?.tracks.find((t) => t.id === edit.track_id)?.label;
  const length =
    isSplit || edit.source_start == null || edit.source_end == null
      ? null
      : formatSeconds(edit.source_end - edit.source_start);
  const time = [tlStart != null ? formatTimeMs(tlStart) : null, length]
    .filter(Boolean)
    .join(" · ");
  const barHasVerbs = verbsOnBar && pendingOffersCut(edit);
  const inlineActions = !barHasVerbs && (canApply || edit.exact_range != null);
  const askComposer = {
    body: askBody,
    onBodyChange: setAskBody,
    onSubmit: () => void postAsk(),
    state: busy || threadBusy ? ("posting" as const) : ("idle" as const),
    name: { value: author, onChange: setAuthor },
  };
  const shownError =
    error && errorCode === TRANSCRIPT_REFINE_REQUIRED_CODE
      ? REFINE_GATE_GUI_MESSAGE
      : combinedError;

  const reviewBlockedReason = timingBusy
    ? BUSY_REASON
    : !canApply
      ? "Only the host or an Editor can review exact range proposals."
      : undefined;

  const renderTimingFields = () => {
    if (edit.exact_range)
      return (
        <p className="sys-decision-why sys-mono">
          {edit.exact_range.intervals
            .map((r) => `${formatTimeMs(r.start)} – ${formatTimeMs(r.end)}`)
            .join(" · ")}
        </p>
      );
    if (!canNudge)
      return (
        <p className="sys-decision-why sys-mono">
          {`${sourceTime(edit.source_start)} – ${sourceTime(edit.source_end)}`}
        </p>
      );
    if (isSplit)
      return (
        <div className="sys-decision-fields">
          <div className="sys-decision-field">
            <span>Cut time</span>
            <span id={pendingEditTimingFieldId(edit.id, "start")}>
              <ScrubField
                label="Cut time"
                value={edit.source_start}
                unit="s"
                step={0.01}
                decimals={6}
                min={0}
                skipUnchanged
                readOnly={timingBusy}
                onCommit={(value) => void commitSplit(value)}
              />
            </span>
          </div>
          <div className="sys-decision-field">
            <span>Tracks</span>
            <TrackToggleRow
              label="Tracks"
              tracks={(project?.tracks ?? []).map((track) => ({
                id: track.id,
                label: track.label,
              }))}
              value={edit.track_ids ?? [edit.track_id]}
              disabled={timingBusy}
              onChange={(ids) => void commitSplit(null, ids)}
            />
          </div>
        </div>
      );
    return (
      <div className="sys-decision-fields">
        {(["start", "end"] as const).map((edge) => (
          <div key={edge} className="sys-decision-field">
            <span>{edge === "start" ? "Start" : "End"}</span>
            <span id={pendingEditTimingFieldId(edit.id, edge)}>
              <ScrubField
                label={edge === "start" ? "Source start" : "Source end"}
                value={shownEdge(edge)}
                unit="s"
                step={0.01}
                decimals={6}
                min={0}
                skipUnchanged
                readOnly={timingBusy}
                onCommit={(value) => void commitEdge(edge, value)}
              />
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <aside className="inspector modifier-inspector">
      <div className="modifier-body">
        {edit.exact_range && !canApply ? (
          <p className="ui-field-hint">
            Only the host or an Editor can review exact range proposals.
          </p>
        ) : null}
        <DecisionCard
          layout="compact"
          kind={decisionKindOf(edit.kind)}
          title={title}
          time={time}
          speaker={speaker ? { name: speaker } : undefined}
          why={edit.why ?? pendingReasonLabel(edit.reason, edit.kind)}
          confidence={edit.cut_confidence ?? undefined}
          inlineActions={inlineActions}
          verb="approve"
          keepLabel="Reject"
          verbDisabledReason={reviewBlockedReason}
          keepDisabledReason={reviewBlockedReason}
          onVerb={() => void runAction("approve")}
          onKeep={() => void runAction("reject")}
        >
          {renderTimingFields()}
        </DecisionCard>
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
        <section className="edit-ask" aria-label="Ask about this edit">
          <h3>Ask</h3>
          {thread ? (
            <div {...presenceAnchorProps(presenceAnchor("comment", thread.id))}>
              <CommentCard
                comment={commentCardOf(
                  thread,
                  thread.resolved,
                  project?.timeline_duration_sec ?? Number.NaN,
                )}
                onResolve={
                  canApply ? (next) => void resolve(thread, next) : undefined
                }
                onToggleAction={
                  canApply
                    ? (actionId, done) =>
                        void toggleAction(thread, actionId, done)
                    : undefined
                }
                reply={
                  mayReply
                    ? { ...askComposer, inputRef: setReplyField }
                    : undefined
                }
              />
            </div>
          ) : (
            <>
              <p className="inspector-body">
                Ask a question here before you approve or reject.
              </p>
              {mayAsk ? (
                <Composer
                  {...askComposer}
                  label="Your question"
                  placeholder="Ask for more context before deciding…"
                  submitLabel="Ask"
                />
              ) : null}
            </>
          )}
        </section>
      </div>
      {shownError ? (
        <div className="modifier-error">
          <InlineError message={shownError} />
        </div>
      ) : null}
      {tlStart != null ? (
        <PendingWarm projectPath={projectPath} editId={edit.id} />
      ) : null}
      {tlStart != null && !verbsOnBar ? (
        <footer className="modifier-footer">
          <PendingPreview
            edit={edit}
            projectPath={projectPath}
            seekSec={tlStart}
            mode={previewMode}
            onModeChange={setPreviewMode}
            onError={setThreadError}
          />
        </footer>
      ) : null}
    </aside>
  );
}
