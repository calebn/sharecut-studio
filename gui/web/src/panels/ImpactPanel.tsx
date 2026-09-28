import { useMemo } from "react";
import { approveEdits, rejectEdits } from "../api";
import { useProjectMutation } from "../hooks/useProjectMutation";
import {
  REFINE_GATE_GUI_MESSAGE,
  TranscriptRefineRecovery,
} from "../inspector/TranscriptRefineRecovery";
import { useQueuedReviewNotice } from "../inspector/useQueuedReviewNotice";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  appliedEditTitle,
  appliedRecordOnTimeline,
} from "../timeline/appliedEditTicks";
import { Button, InlineError } from "../ui";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { selectUnmappedPending, UNMAPPED_PENDING_TITLE } from "../utils/edits";

export function ImpactPanel() {
  const { project, projectPath, setSelection } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const { busy, error, errorCode, setError, run } = useProjectMutation();
  const { notice: queuedNotice, setQueued } =
    useQueuedReviewNotice(projectPath);
  const appliedRecords = project?.applied_edits.records;
  const clipsByTrack = project?.clips.tracks;
  // One projection pass per document change, not per render (records × tracks × clips).
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
  const reviewRequired = project.pending_edits.filter((e) => e.review_required);

  const runBulk = async (action: "approve" | "reject") => {
    const ids = reviewRequired.map((e) => e.id);
    if (ids.length === 0) {
      return;
    }
    setQueued(false);
    await run(async () => {
      const { queued } =
        action === "approve"
          ? await approveEdits(projectPath, ids)
          : await rejectEdits(projectPath, ids);
      setQueued(queued);
      setSelection(null);
    });
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

      {reviewRequired.length > 0 && (
        <div className="impact-bulk">
          <div className="impact-bulk-actions">
            <Button disabled={busy} onClick={() => void runBulk("approve")}>
              Approve all review-required ({reviewRequired.length})
            </Button>
            <Button disabled={busy} onClick={() => void runBulk("reject")}>
              Reject all review-required
            </Button>
          </div>
          <ul className="impact-pending-list">
            {reviewRequired.map((e) => (
              <li key={e.id}>
                <Button
                  variant="link"
                  data-pending-id={e.id}
                  onClick={() =>
                    setSelection({
                      kind: "pending",
                      id: e.id,
                      trackId: e.track_id,
                    })
                  }
                >
                  {e.reason ?? e.type} · {e.track_id}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
          key={reviewRequired.map((edit) => edit.id).join(",")}
          projectPath={projectPath}
          error={error}
          errorCode={errorCode}
          onRecovered={() => setError(null)}
        />
      ) : null}
    </div>
  );
}
