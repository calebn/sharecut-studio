import { useEffect } from "react";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { isTerminalJobStatus } from "../utils/pipeline";
import {
  pipelineKindLabel,
  pipelineStatusLabel,
} from "../utils/pipelineProgress";

/**
 * Speak the Activity/Pipeline chip's status in the shell's polite live region,
 * plus any job's own result copy (Bounce, Export) handed over through
 * `announceJobResult` (#704). Mounted by whichever shell is showing:
 * `StatusBar` (desktop/tablet) or `MobileShellView` (phone).
 *
 * - A job registered with `expectJobResult` never gets the generic
 *   "<Kind>: ok" headline. Its caller's copy is spoken instead, so the two
 *   never race in the live region.
 * - A result for the chip's own job waits until that chip reaches a terminal
 *   status. A result for any other job (the chip has moved on) is spoken at
 *   once. Results that are ready in the same pass are joined into one
 *   announcement, because the live region holds a single message.
 * - A spoken result is dropped from the store, and its job id is remembered in the store's bounded list (`spokenJobResultIds`), not in the hook. So neither a later chip update for any spoken job (such as the running count dropping) nor a remount (desktop <-> phone shell) announces the generic headline over it.
 */
export function useJobStatusAnnouncement(): void {
  const {
    pipelineJob,
    activityJob,
    activityRunningCount,
    pendingJobResults,
    announceStatus,
    markJobResultsSpoken,
  } = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    pendingJobResults: s.pendingJobResults,
    announceStatus: s.announceStatus,
    markJobResultsSpoken: s.markJobResultsSpoken,
  }));
  const chipJob = activityJob ?? pipelineJob;
  const jobId = chipJob?.id;
  const jobStatus = chipJob?.status;
  const jobMessage = chipJob?.message || chipJob?.label;
  const jobKind = chipJob?.kind;
  const chipTerminal = jobStatus != null && isTerminalJobStatus(jobStatus);

  useEffect(() => {
    if (!jobStatus) {
      return;
    }
    // Read at effect time on purpose, not as dependencies: settling an entry or
    // recording the spoken id must not re-run this effect and speak the
    // generic headline over the copy.
    const { pendingJobResults: pending, spokenJobResultIds } =
      useDawStore.getState();
    if (chipTerminal && jobId != null && spokenJobResultIds.includes(jobId)) {
      return;
    }
    if (jobStatus === "ok" && jobId != null && jobId in pending) {
      return;
    }
    const parts = [
      `${pipelineKindLabel(jobKind)}: ${pipelineStatusLabel(jobStatus)}`,
    ];
    if (jobMessage) {
      parts.push(jobMessage);
    }
    if (activityRunningCount > 1) {
      parts.push(`${activityRunningCount} activities`);
    }
    announceStatus(parts.join(": "));
  }, [
    activityRunningCount,
    announceStatus,
    chipTerminal,
    jobId,
    jobKind,
    jobStatus,
    jobMessage,
  ]);

  useEffect(() => {
    const readyIds: string[] = [];
    const messages: string[] = [];
    for (const [id, message] of Object.entries(pendingJobResults)) {
      if (message == null || (id === jobId && !chipTerminal)) {
        continue;
      }
      readyIds.push(id);
      messages.push(message);
    }
    if (readyIds.length === 0) {
      return;
    }
    // One write: `statusAnnouncement` is a single field, so one write per
    // result would keep only the last.
    announceStatus(messages.join(". "));
    markJobResultsSpoken(readyIds);
  }, [
    announceStatus,
    chipTerminal,
    jobId,
    markJobResultsSpoken,
    pendingJobResults,
  ]);
}
