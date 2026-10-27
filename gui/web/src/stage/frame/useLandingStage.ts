import { useEffect } from "react";
import { useDawStore } from "../../state/dawStore";
import {
  landingStage,
  stageRoleOf,
  stagesForRole,
} from "../../state/stageRoutes";
import { takeOpenStage } from "../../utils/openIntent";
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
    const role = stageRoleOf(s.guestMode);
    // A Home card names the stage its chip promised; that wins once.
    const named = takeOpenStage(s.projectPath);
    const next =
      named && stagesForRole(role).includes(named)
        ? named
        : landingStage({
            role,
            trackCount: project.tracks.length,
            jobBusy:
              isPipelineSlotBusy(s.activityJob) ||
              isPipelineSlotBusy(s.pipelineJob),
            pendingReviewCount: project.edit_impact.pending_review_count,
            lastStage:
              s.guestMode == null ? readLastStage(s.projectPath) : null,
          });
    if (next === s.stage) s.markLandingSettled();
    else s.openStage(next);
  }, [waiting]);
}
