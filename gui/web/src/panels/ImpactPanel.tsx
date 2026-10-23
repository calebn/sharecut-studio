import { useMemo, useState } from "react";
import { approveEdits, rejectEdits } from "../api";
import { askConfirm } from "../feedback/ask";
import { useProjectMutation } from "../hooks/useProjectMutation";
import {
  REFINE_GATE_GUI_MESSAGE,
  TranscriptRefineRecovery,
} from "../inspector/TranscriptRefineRecovery";
import { useQueuedReviewNotice } from "../inspector/useQueuedReviewNotice";
import { canReviewPendingEdit, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import {
  appliedEditTitle,
  appliedRecordOnTimeline,
} from "../timeline/appliedEditTicks";
import { Button, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { selectUnmappedPending, UNMAPPED_PENDING_TITLE } from "../utils/edits";
import { pendingListRowLabel } from "../utils/pendingEditLabels";
import {
  type BulkReviewAction,
  bulkReviewQuestion,
  capturePendingReview,
  finishPendingReview,
  reviewPassOf,
} from "../utils/pendingReviewPass";

import { BulkReviewWorking } from "./BulkReviewWorking";

const REVIEW_FORBIDDEN_REASON =
  "Only the host or an Editor can review suggestions.";

export function ImpactPanel() {
  const { project, projectPath, shareCapabilities, setSelection } = useDaw(
    (s) => ({
      project: s.project,
      projectPath: s.projectPath,
      shareCapabilities: s.shareCapabilities,
      setSelection: s.setSelection,
    }),
  );
  const { busy, error, errorCode, setError, run, refresh } =
    useProjectMutation();
  const [working, setWorking] = useState<{
    action: BulkReviewAction;
    count: number;
    startedAtSec: number;
  } | null>(null);
  const { notice: queuedNotice, setQueued } =
    useQueuedReviewNotice(projectPath);
  const appliedRecords = project?.applied_edits.records;
  const clipsByTrack = project?.clips.tracks;
  const onTimelineIds = useMemo(() => {
    const ids = new Set<string>();
    if (!appliedRecords || !clipsByTrack) {
      return ids;
    }
    for (const rec of appliedRecords) {
      if (appliedRecordOnTimeline(rec, clipsByTrack)) {
        ids.add(rec.id);
      }
    }
    return ids;
  }, [appliedRecords, clipsByTrack]);

  if (!project) {
    return null;
  }
  const imp = project.edit_impact;
  const unmappable = selectUnmappedPending(project.pending_edits);
  const reviewPass = reviewPassOf(project.pending_edits);
  const reviewCount = reviewPass.ids.length;

  const canReviewAll = canReviewPendingEdit(projectPath, shareCapabilities);

  const runBulk = async (action: BulkReviewAction) => {
    const live = useDawStore.getState();
    if (live.projectPath !== projectPath || !live.project) return;
    if (!canReviewPendingEdit(live.projectPath, live.shareCapabilities)) return;
    const shown = reviewPassOf(live.project.pending_edits);
    if (shown.ids.length === 0) {
      return;
    }
    if (!(await askConfirm(bulkReviewQuestion(action, shown)))) {
      return;
    }
    const fresh = useDawStore.getState();
    if (fresh.projectPath !== projectPath || !fresh.project) return;
    const stillWaiting = new Set(reviewPassOf(fresh.project.pending_edits).ids);
    const ids = shown.ids.filter((id) => stillWaiting.has(id));
    if (ids.length === 0) {
      return;
    }
    setQueued(false);
    const review = capturePendingReview(action, projectPath);
    setWorking({
      action,
      count: ids.length,
      startedAtSec: Date.now() / 1000,
    });
    await run(async () => {
      const outcome =
        action === "approve"
          ? await approveEdits(projectPath, ids, true, true)
          : await rejectEdits(projectPath, ids);
      const { queued } = outcome;
      setQueued(queued);
      setSelection(null);
      if (!queued) {
        finishPendingReview(review, outcome);
        await refresh();
      }
    });
    setWorking(null);
  };

  return (
    <div className="impact-panel">
      <dl>
        <dt>Total removed</dt>
        <dd>{imp.total_removed_sec.toFixed(2)} s</dd>
        <dt>Pending review</dt>
        <dd>{imp.pending_review_count}</dd>
        {unmappable.length > 0 && (
          <>
            <dt>{UNMAPPED_PENDING_TITLE}</dt>
            <dd>
              {unmappable.length}{" "}
              <Button
                variant="link"
                onClick={() =>
                  setSelection({
                    kind: "pending",
                    id: unmappable[0].id,
                    trackId: unmappable[0].track_id,
                  })
                }
              >
                inspect
              </Button>
            </dd>
          </>
        )}
        {Object.entries(imp.by_track_sec).map(([tid, sec]) => (
          <div key={tid}>
            <dt>{tid}</dt>
            <dd>{sec.toFixed(2)} s</dd>
          </div>
        ))}
      </dl>

      {project.applied_edits.records.length > 0 && (
        <details className="impact-applied">
          <summary>
            Applied edits ({project.applied_edits.records.length})
          </summary>
          <ul className="impact-pending-list">
            {project.applied_edits.records.map((rec) => (
              <li key={rec.id}>
                <Button
                  variant="link"
                  data-applied-id={rec.id}
                  onClick={() =>
                    setSelection(
                      rec.track_ids[0]
                        ? {
                            kind: "applied",
                            id: rec.id,
                            trackId: rec.track_ids[0],
                          }
                        : { kind: "applied", id: rec.id },
                    )
                  }
                >
                  {appliedEditTitle(rec)} ·{" "}
                  {rec.track_ids.join(", ") || "session"}
                  {onTimelineIds.has(rec.id) ? "" : " · not on timeline"}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {reviewCount > 0 && (
        <div className="impact-bulk">
          <p className="impact-bulk-lead">
            {reviewCount === 1
              ? "1 pending edit needs review."
              : `${reviewCount} pending edits need review.`}
          </p>
          <div className="impact-bulk-actions">
            <Button
              variant="primary"
              disabledReason={
                busy
                  ? BUSY_REASON
                  : canReviewAll
                    ? undefined
                    : REVIEW_FORBIDDEN_REASON
              }
              onClick={() => void runBulk("approve")}
            >
              Approve all ({reviewCount})
            </Button>
            <Button
              disabledReason={
                busy
                  ? BUSY_REASON
                  : canReviewAll
                    ? undefined
                    : REVIEW_FORBIDDEN_REASON
              }
              onClick={() => void runBulk("reject")}
            >
              Reject all ({reviewCount})
            </Button>
          </div>
          {working ? (
            <BulkReviewWorking
              verb={working.action === "approve" ? "Approving" : "Rejecting"}
              count={working.count}
              startedAtSec={working.startedAtSec}
            />
          ) : null}
          {canReviewAll ? null : (
            <p className="impact-bulk-reason">{REVIEW_FORBIDDEN_REASON}</p>
          )}
        </div>
      )}
      {project.pending_edits.length > 0 ? (
        <ul className="impact-pending-list" aria-label="Pending edits">
          {project.pending_edits.map((edit) => (
            <li key={edit.id}>
              <Button
                className="impact-pending-select"
                variant="link"
                data-pending-id={edit.id}
                onClick={() =>
                  setSelection({
                    kind: "pending",
                    id: edit.id,
                    trackId: edit.track_id,
                  })
                }
              >
                {pendingListRowLabel(edit, project.tracks)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <InlineError
        message={
          error && errorCode === TRANSCRIPT_REFINE_REQUIRED_CODE
            ? REFINE_GATE_GUI_MESSAGE
            : error
        }
      />
      {queuedNotice}
      {!isShareProjectKey(projectPath) ? (
        <TranscriptRefineRecovery
          key={reviewPass.ids.join(",")}
          projectPath={projectPath}
          error={error}
          errorCode={errorCode}
          onRecovered={() => setError(null)}
        />
      ) : null}
    </div>
  );
}
