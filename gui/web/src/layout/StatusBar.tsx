import { useJobStatusAnnouncement } from "../hooks/useJobStatusAnnouncement";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { useDaw } from "../state/useDaw";
import { pipelineChipOpensPanel } from "../utils/pipeline";
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
  } = useDaw((s) => ({
    project: s.project,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    setActiveTab: s.setActiveTab,
    shellBreakpoint: s.shellBreakpoint,
    highlightStaleRender: s.highlightStaleRender,
    statusAnnouncement: s.statusAnnouncement,
  }));

  const chipJob = activityJob ?? pipelineJob;
  useJobStatusAnnouncement();

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
