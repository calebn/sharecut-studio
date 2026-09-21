import { approveEdits, rejectEdits } from "../api";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { TranscriptRefineRecovery } from "../inspector/TranscriptRefineRecovery";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { Button, InlineError } from "../ui";
import { selectUnmappedPending } from "../utils/edits";

export function ImpactPanel() {
  const { project, projectPath, setSelection } = useDaw();
  const { busy, error, setError, run } = useProjectMutation();

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
    await run(async () => {
      if (action === "approve") {
        await approveEdits(projectPath, ids);
      } else {
        await rejectEdits(projectPath, ids);
      }
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
            <dt>Unmapped pending</dt>
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
      <InlineError message={error} />
      {!isShareProjectKey(projectPath) ? (
        <TranscriptRefineRecovery
          key={reviewRequired.map((edit) => edit.id).join(",")}
          projectPath={projectPath}
          error={error}
          onRecovered={() => setError(null)}
        />
      ) : null}
    </div>
  );
}
