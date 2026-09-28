import { useEffect } from "react";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { useDaw } from "../state/useDaw";
import { isTerminalJobStatus, pipelineChipOpensPanel } from "../utils/pipeline";
import {
  pipelineKindLabel,
  pipelineStatusLabel,
} from "../utils/pipelineProgress";
import { PresenceStatus } from "./PresenceStatus";
import { StatusBarView } from "./StatusBarView";
import { statusBarSummary } from "./statusBarSummary";

export function StatusBar({ guestShare = false }: { guestShare?: boolean }) {
  const {
    project,
    pipelineJob,
    activityJob,
    activityRunningCount,
    setActiveTab,
    shellBreakpoint,
    highlightStaleRender,
    statusAnnouncement,
    jobResultAnnouncement,
    announceStatus,
  } = useDaw((s) => ({
    project: s.project,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    setActiveTab: s.setActiveTab,
    shellBreakpoint: s.shellBreakpoint,
    highlightStaleRender: s.highlightStaleRender,
    statusAnnouncement: s.statusAnnouncement,
    jobResultAnnouncement: s.jobResultAnnouncement,
    announceStatus: s.announceStatus,
  }));

  const chipJob = activityJob ?? pipelineJob;
  const jobId = chipJob?.id;
  const jobStatus = chipJob?.status;
  const jobMessage = chipJob?.message || chipJob?.label;
  const jobKind = chipJob?.kind;
  const jobResult = jobResultAnnouncement;
  useEffect(() => {
    if (!jobStatus) {
      return;
    }
    // A job's own terminal-result copy (BounceDialog, export.deliverables)
    // wins over this generic headline instead of racing it (#704): announce
    // it once that job's chip reaches a terminal status, and stay quiet
    // while it is still running so the result copy is not clobbered first.
    if (jobResult && jobResult.jobId === jobId) {
      if (isTerminalJobStatus(jobStatus)) {
        announceStatus(jobResult.message);
      }
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
    jobId,
    jobKind,
    jobStatus,
    jobMessage,
    jobResult,
  ]);

  // Same source as the transport pill, so the two never disagree.
  const render = useStaleRenderBreakdown(project);
  const narrow = shellBreakpoint === "phone" || shellBreakpoint === "tablet";

  return (
    <StatusBarView
      summary={project ? statusBarSummary(project, render) : null}
      narrow={narrow}
      presence={<PresenceStatus narrow={narrow} />}
      reconcileHighlight={highlightStaleRender && render.reconcileStale}
      job={chipJob}
      runningCount={activityRunningCount}
      onJobClick={
        chipJob && !guestShare && pipelineChipOpensPanel(chipJob)
          ? () => setActiveTab("pipeline")
          : undefined
      }
      statusAnnouncement={statusAnnouncement}
      onOpenTab={setActiveTab}
    />
  );
}
