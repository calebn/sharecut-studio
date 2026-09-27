import type { ProjectView } from "../types/project";
import { selectUnmappedPending } from "../utils/edits";
import { type TimelineCut, timelineCut } from "../utils/projectMedia";
import type { StaleRenderBreakdown } from "../utils/staleRender";

/**
 * Status-bar fields derived from a project and its render breakdown, so the
 * view, the adapter and the catalog stories all read the same summary.
 */
export type StatusBarSummary = {
  pendingReviewCount: number;
  unmappedCount: number;
  cut: TimelineCut | null;
  socialClipCount: number;
  renderStale: boolean;
  renderSummary: string;
  transcriptNeedsSync: boolean;
};

export function statusBarSummary(
  project: ProjectView,
  render: StaleRenderBreakdown,
): StatusBarSummary {
  const { edit_impact, pending_edits, social_clips } = project;
  return {
    pendingReviewCount: edit_impact.pending_review_count,
    unmappedCount: selectUnmappedPending(pending_edits).length,
    cut: timelineCut(project),
    socialClipCount: social_clips?.length ?? 0,
    renderStale: render.stale,
    renderSummary: render.summary,
    transcriptNeedsSync: render.reconcileStale,
  };
}
