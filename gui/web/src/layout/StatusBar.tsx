import { runPointerCommand } from "../commands/pointer";
import { useJobStatusAnnouncement } from "../hooks/useJobStatusAnnouncement";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { JobModelDownload } from "../models";
import { useDaw } from "../state/useDaw";
import { pipelineChipOpensPanel } from "../utils/pipeline";
import { PresenceStatus } from "./PresenceStatus";
import { SaveStateDot } from "./SaveStateDot";
import { StatusBarView } from "./StatusBarView";
import { statusBarSummary } from "./statusBarSummary";

export function StatusBar({ guestShare = false }: { guestShare?: boolean }) {
  const {
    project,
    pipelineJob,
    activityJob,
    activityRunningCount,
    shellBreakpoint,
    highlightStaleRender,
    statusAnnouncement,
    statusAnnouncementSeq,
  } = useDaw((s) => ({
    project: s.project,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    shellBreakpoint: s.shellBreakpoint,
    highlightStaleRender: s.highlightStaleRender,
    statusAnnouncement: s.statusAnnouncement,
    statusAnnouncementSeq: s.statusAnnouncementSeq,
  }));

  const chipJob = activityJob ?? pipelineJob;
  useJobStatusAnnouncement();

  const render = useStaleRenderBreakdown(project);
  const narrow = shellBreakpoint === "phone" || shellBreakpoint === "tablet";

  return (
    <StatusBarView
      guestShare={guestShare}
      summary={project ? statusBarSummary(project, render) : null}
      narrow={narrow}
      presence={<PresenceStatus narrow={narrow} />}
      saveState={<SaveStateDot />}
      reconcileHighlight={highlightStaleRender && render.reconcileStale}
      job={chipJob}
      jobAction={
        guestShare ? null : (
          <JobModelDownload job={chipJob} className="status-chip" />
        )
      }
      runningCount={activityRunningCount}
      onJobClick={
        chipJob && !guestShare && pipelineChipOpensPanel(chipJob)
          ? () => runPointerCommand("view.setTab", { tab: "pipeline" })
          : undefined
      }
      statusAnnouncement={statusAnnouncement}
      statusAnnouncementSeq={statusAnnouncementSeq}
      onOpenTab={(tab) => runPointerCommand("view.setTab", { tab })}
    />
  );
}
