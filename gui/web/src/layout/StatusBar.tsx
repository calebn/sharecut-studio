import { useEffect } from "react";
import { useDaw } from "../state/useDaw";
import { selectUnmappedPending } from "../utils/edits";
import { pipelineChipOpensPanel } from "../utils/pipeline";
import {
  pipelineKindLabel,
  pipelineStatusLabel,
} from "../utils/pipelineProgress";
import { staleRenderBreakdown } from "../utils/staleRender";
import { PipelineStatusChip } from "./PipelineStatusChip";

export function StatusBar({ guestShare = false }: { guestShare?: boolean }) {
  const {
    project,
    pipelineJob,
    activityJob,
    activityRunningCount,
    setActiveTab,
    setFocusMode,
    shellBreakpoint,
    sessionClients,
    highlightStaleRender,
    statusAnnouncement,
    announceStatus,
  } = useDaw();

  const chipJob = activityJob ?? pipelineJob;
  const jobStatus = chipJob?.status;
  const jobMessage = chipJob?.message || chipJob?.label;
  const jobKind = chipJob?.kind;
  useEffect(() => {
    if (!jobStatus) {
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
  }, [activityRunningCount, announceStatus, jobKind, jobStatus, jobMessage]);

  if (!project) {
    return (
      <footer className="status-bar">
        Loading episode…
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusAnnouncement}
        </span>
      </footer>
    );
  }

  const { edit_impact, pending_edits, social_clips } = project;
  const unmappable = selectUnmappedPending(pending_edits).length;
  const narrow = shellBreakpoint === "phone" || shellBreakpoint === "tablet";
  const viewers = sessionClients.filter((c) => c.role !== "agent").length;
  // Same source as the transport pill, so the two never disagree.
  const render = staleRenderBreakdown(project);
  const reconcileHighlight = highlightStaleRender && render.reconcileStale;

  return (
    <footer className="status-bar">
      {sessionClients.length > 0 && (
        <span
          className={narrow ? "status-bar-secondary" : undefined}
          title={sessionClients
            .map(
              (c) =>
                `${c.meta?.display_name || c.label || c.client_id} (${c.role})`,
            )
            .join(", ")}
        >
          Presence: {sessionClients.length}
          {viewers > 0 ? ` · ${viewers} guest` : ""}
        </span>
      )}
      <button
        type="button"
        className="ui-control status-chip"
        onClick={() => {
          setActiveTab("impact");
          setFocusMode("default");
        }}
      >
        Pending: {edit_impact.pending_review_count}
      </button>
      {unmappable > 0 && (
        <button
          type="button"
          className="ui-control status-chip"
          onClick={() => setActiveTab("impact")}
        >
          Unmapped: {unmappable}
        </button>
      )}
      <span className={narrow ? "status-bar-secondary" : undefined}>
        Removed: {edit_impact.total_removed_sec.toFixed(1)}s
      </span>
      {(social_clips?.length ?? 0) > 0 && (
        <span className={narrow ? "status-bar-secondary" : undefined}>
          Social: {social_clips.length}
        </span>
      )}
      <button
        type="button"
        className="ui-control status-chip"
        title={render.summary}
        onClick={() => setActiveTab("pipeline")}
      >
        Render: {render.stale ? "stale" : "fresh"}
      </button>
      {render.reconcileStale ? (
        <span className={reconcileHighlight ? "stale-highlight" : undefined}>
          Transcript: needs sync
        </span>
      ) : null}
      {chipJob && (
        <PipelineStatusChip
          job={chipJob}
          runningCount={activityRunningCount}
          onClick={
            !guestShare && pipelineChipOpensPanel(chipJob)
              ? () => setActiveTab("pipeline")
              : undefined
          }
        />
      )}
      <button
        type="button"
        className={`ui-control status-chip status-bar-end${narrow ? " status-bar-secondary" : ""}`}
        onClick={() => {
          setActiveTab("comments");
          setFocusMode("review");
        }}
      >
        Open comments
      </button>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusAnnouncement}
      </span>
    </footer>
  );
}
