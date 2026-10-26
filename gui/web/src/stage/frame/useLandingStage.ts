import { useEffect } from "react";
import { useDawStore } from "../../state/dawStore";
import { landingStage, stageRoleOf } from "../../state/stageRoutes";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { readLastStage } from "../../utils/stagePref";

/**
 * Picks the stage a project opens on, once per project open. A stage the
 * person chose first settles it, so this never moves them afterwards.
 */
export function useLandingStage(): void {
  const waiting = useDawStore((s) => s.project != null && !s.landingSettled);
  useEffect(() => {
    if (!waiting) return;
    const s = useDawStore.getState();
    const project = s.project;
    if (!project) return;
    const next = landingStage({
      role: stageRoleOf(s.guestMode),
      trackCount: project.tracks.length,
      jobBusy:
        isPipelineSlotBusy(s.activityJob) || isPipelineSlotBusy(s.pipelineJob),
      pendingReviewCount: project.edit_impact.pending_review_count,
      lastStage: readLastStage(s.projectPath),
    });
    if (next === s.stage) s.markLandingSettled();
    else s.setStage(next);
  }, [waiting]);
}
