import { liveTakeOpen, useRecordHostStore } from "../../record";
import { useDaw } from "../../state/useDaw";
import type { StageBadge } from "../../system/StageBar";
import type { StageId } from "../../system/verbs";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { isPipelineKindJob, isPipelineSlotBusy } from "../../utils/pipeline";

export type StageBadgeInput = {
  pipelineJob: PipelineJobSnapshot | null;
  activityJob: PipelineJobSnapshot | null;
  /** Pending edits waiting on a decision. */
  pendingReviewCount: number;
  /** Comments nobody has resolved. */
  openCommentCount: number;
};

/**
 * What each stage tab says without being opened: Prepare while a job runs or
 * after one failed, Review while anything waits on a decision. Record shows
 * live through the Stage bar's `live`; Deliver has no badge yet.
 */
export function stageBadges(
  input: StageBadgeInput,
): Partial<Record<StageId, StageBadge>> {
  const badges: Partial<Record<StageId, StageBadge>> = {};
  const job = input.activityJob ?? input.pipelineJob;
  if (isPipelineSlotBusy(job)) {
    badges.prepare = { kind: "running" };
  } else if (job?.status === "error" && isPipelineKindJob(job)) {
    badges.prepare = { kind: "failed" };
  }
  const waiting = input.pendingReviewCount + input.openCommentCount;
  if (waiting > 0) {
    badges.review = { kind: "needs-you", count: waiting };
  }
  return badges;
}

export function useStageBadges(): Partial<Record<StageId, StageBadge>> {
  const input = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    pendingReviewCount: s.project?.edit_impact.pending_review_count ?? 0,
    openCommentCount:
      s.project?.comments?.filter((c) => !c.resolved).length ?? 0,
  }));
  return stageBadges(input);
}

/** A take is on: recording or paused, not the lobby. */
export function useRecordLive(): boolean {
  return useRecordHostStore((s) => liveTakeOpen(s.snapshot?.state));
}
