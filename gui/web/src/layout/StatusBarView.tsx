import type { ReactNode } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { unmappedPendingLabel } from "../utils/edits";
import { formatTimeShort } from "../utils/time";
import { PipelineStatusChip } from "./PipelineStatusChip";
import type { StatusBarSummary } from "./statusBarSummary";

export type { StatusBarSummary } from "./statusBarSummary";
export type StatusBarTab = "impact" | "pipeline" | "comments";

type Props = {
  summary: StatusBarSummary | null;
  narrow: boolean;
  presence?: ReactNode;
  reconcileHighlight?: boolean;
  job?: PipelineJobSnapshot | null;
  runningCount?: number;
  onJobClick?: () => void;
  nowSec?: number;
  statusAnnouncement: string;
  onOpenTab: (tab: StatusBarTab) => void;
};

/** Props-only status bar footer, shared by the live adapter and its stories. */
export function StatusBarView({
  summary,
  narrow,
  presence,
  reconcileHighlight,
  job,
  runningCount,
  onJobClick,
  nowSec,
  statusAnnouncement,
  onOpenTab,
}: Props) {
  const liveRegion = (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {statusAnnouncement}
    </span>
  );

  if (!summary) {
    return (
      <footer className="status-bar">
        Loading episode…
        {liveRegion}
      </footer>
    );
  }

  const {
    pendingReviewCount,
    unmappedCount,
    cut,
    socialClipCount,
    renderStale,
    renderSummary,
    transcriptNeedsSync,
  } = summary;

  return (
    <footer className="status-bar">
      {presence}
      <button
        type="button"
        className="ui-control status-chip"
        onClick={() => onOpenTab("impact")}
      >
        Pending: {pendingReviewCount}
      </button>
      {unmappedCount > 0 && (
        <button
          type="button"
          className="ui-control status-chip"
          onClick={() => onOpenTab("impact")}
        >
          {unmappedPendingLabel(unmappedCount)}
        </button>
      )}
      {cut && (
        <span
          className={narrow ? "status-bar-secondary" : undefined}
          title={`Timeline ${formatTimeShort(cut.timelineSec)} from ${formatTimeShort(cut.sourceSec)} of source audio`}
        >
          Cut {formatTimeShort(cut.cutSec)} of {formatTimeShort(cut.sourceSec)}
        </span>
      )}
      {socialClipCount > 0 && (
        <span className={narrow ? "status-bar-secondary" : undefined}>
          Social: {socialClipCount}
        </span>
      )}
      <button
        type="button"
        className="ui-control status-chip"
        title={renderSummary}
        onClick={() => onOpenTab("pipeline")}
      >
        Render: {renderStale ? "stale" : "fresh"}
      </button>
      {transcriptNeedsSync ? (
        <span className={reconcileHighlight ? "stale-highlight" : undefined}>
          Transcript: needs sync
        </span>
      ) : null}
      {job && (
        <PipelineStatusChip
          job={job}
          runningCount={runningCount}
          onClick={onJobClick}
          nowSec={nowSec}
        />
      )}
      <button
        type="button"
        className={`ui-control status-chip status-bar-end${narrow ? " status-bar-secondary" : ""}`}
        onClick={() => onOpenTab("comments")}
      >
        Open comments
      </button>
      {liveRegion}
    </footer>
  );
}
