import { useEffect, useRef } from "react";
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
 *   once.
 * - A spoken result is dropped from the store, and later chip updates for that
 *   same terminal job (such as the running count dropping) do not re-announce
 *   the generic headline over it.
 */
export function useJobStatusAnnouncement(): void {
  const {
    pipelineJob,
    activityJob,
    activityRunningCount,
    pendingJobResults,
    announceStatus,
    settleJobResult,
  } = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    pendingJobResults: s.pendingJobResults,
    announceStatus: s.announceStatus,
    settleJobResult: s.settleJobResult,
  }));
  const chipJob = activityJob ?? pipelineJob;
  const jobId = chipJob?.id;
  const jobStatus = chipJob?.status;
  const jobMessage = chipJob?.message || chipJob?.label;
  const jobKind = chipJob?.kind;
  const chipTerminal = jobStatus != null && isTerminalJobStatus(jobStatus);
  // Job id whose own result copy this hook spoke most recently.
  const spokenResultFor = useRef<string | null>(null);

  useEffect(() => {
    if (!jobStatus) {
      return;
    }
    if (chipTerminal && jobId === spokenResultFor.current) {
      return;
    }
    // Read at effect time on purpose, not as a dependency: settling an entry
    // must not re-run this effect and speak the generic headline over the copy.
    if (
      jobStatus === "ok" &&
      jobId != null &&
      jobId in useDawStore.getState().pendingJobResults
    ) {
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
    for (const [id, message] of Object.entries(pendingJobResults)) {
      if (message == null || (id === jobId && !chipTerminal)) {
        continue;
      }
      announceStatus(message);
      spokenResultFor.current = id;
      settleJobResult(id);
    }
  }, [announceStatus, chipTerminal, jobId, pendingJobResults, settleJobResult]);
}
