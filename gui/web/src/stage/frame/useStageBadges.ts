import { useEffect } from "react";
import { shallow } from "zustand/shallow";
import { useHostRoomSelector, useRecordHostStore } from "../../record";
import { reviewCountOf } from "../../review/reviewItems";
import { canReviewPendingEdit, isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { RecordBadge, StageBadge } from "../../system/StageBadgeViews";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { StageId } from "../../types/stage";
import { isPipelineKindJob, isPipelineSlotBusy } from "../../utils/pipeline";
import { recordBadge } from "./recordBadge";

type StageBadgeInput = {
  pipelineJob: PipelineJobSnapshot | null;
  activityJob: PipelineJobSnapshot | null;
  /** Pending edits waiting on a decision. */
  pendingReviewCount: number;
  /** Comments nobody has resolved. */
  openCommentCount: number;
  recordAttention: boolean;
};

/**
 * What each stage tab says without being opened: Prepare while a job runs or
 * after one failed, Review while anything waits on a decision. Record shows
 * its room badge (`useRecordBadge`) and, when the mic or the recording
 * needs the host from another stage, a failed dot; Deliver has no badge yet.
 */
function stageBadges(
  input: StageBadgeInput,
): Partial<Record<StageId, StageBadge>> {
  const badges: Partial<Record<StageId, StageBadge>> = {};
  const job = input.activityJob ?? input.pipelineJob;
  if (isPipelineSlotBusy(job)) {
    badges.prepare = { kind: "running" };
  } else if (job?.status === "error" && isPipelineKindJob(job)) {
    badges.prepare = { kind: "failed" };
  }
  if (input.recordAttention) {
    badges.record = { kind: "failed" };
  }
  const waiting = input.pendingReviewCount + input.openCommentCount;
  if (waiting > 0) {
    badges.review = { kind: "needs-you", count: waiting };
  }
  return badges;
}

export function useStageBadges(): Partial<Record<StageId, StageBadge>> {
  const onRecord = useDawStore((s) => s.stage === "record");
  const micLost = useHostRoomSelector(
    (room) => room?.micLossNeedsAttention ?? false,
    Object.is,
  );
  const otherAttention = useHostRoomSelector(
    (room) => room?.captureUnavailable || room?.noAudioNeedsAttention || false,
    Object.is,
  );
  const recordAttention = !onRecord && (micLost || otherAttention);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const micLostAway = !onRecord && micLost;
  useEffect(() => {
    if (micLostAway) {
      announceStatus("Your mic stopped. Open Record to reconnect it.");
    }
  }, [micLostAway, announceStatus]);
  const input = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    pendingReviewCount:
      isShareProjectKey(s.projectPath) &&
      canReviewPendingEdit(s.projectPath, s.shareCapabilities)
        ? reviewCountOf(s.project?.pending_edits ?? [], true)
        : (s.project?.edit_impact.pending_review_count ?? 0),
    openCommentCount:
      s.project?.comments?.filter((c) => !c.resolved).length ?? 0,
    recordAttention,
  }));
  return stageBadges(input);
}

/** The Record item's room badge: the take, saving, people waiting or an alert. */
export function useRecordBadge(): RecordBadge {
  const away = useDawStore((s) => s.stage !== "record");
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const receivedAtMs = useRecordHostStore((s) => s.receivedAtMs);
  const dropped = useRecordHostStore((s) => s.dropped);
  return useHostRoomSelector(
    (room): RecordBadge =>
      room
        ? recordBadge(room, { captureHealth, receivedAtMs, dropped, away })
        : { kind: "idle" },
    shallow,
  );
}
