import type { ReactNode } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { StatusLiveRegion } from "../ui/StatusLiveRegion";
import { unmappedPendingLabel } from "../utils/edits";
import { formatTimeShort } from "../utils/time";
import { PipelineStatusChip } from "./PipelineStatusChip";
import type { StatusBarSummary } from "./statusBarSummary";

export type { StatusBarSummary } from "./statusBarSummary";
export type StatusBarTab = "impact" | "pipeline" | "comments";

type Props = {
  guestShare?: boolean;
  summary: StatusBarSummary | null;
  narrow: boolean;
  presence?: ReactNode;
  reconcileHighlight?: boolean;
  job?: PipelineJobSnapshot | null;
  runningCount?: number;
  onJobClick?: () => void;
  nowSec?: number;
  statusAnnouncement: string;
  /** Re-speaks a repeated identical announcement (`statusAnnouncementSeq`). */
  statusAnnouncementSeq?: number;
  onOpenTab: (tab: StatusBarTab) => void;
};

/** Props-only status bar footer, shared by the live adapter and its stories. */
export function StatusBarView({
  guestShare = false,
  summary,
  narrow,
  presence,
  reconcileHighlight,
  job,
  runningCount,
  onJobClick,
  nowSec,
  statusAnnouncement,
  statusAnnouncementSeq = 0,
  onOpenTab,
}: Props) {
  const liveRegion = (
    <StatusLiveRegion
      message={statusAnnouncement}
      seq={statusAnnouncementSeq}
    />
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
    transcriptNeedsSync,
  } = summary;

  return (
    <footer className="status-bar">
      {presence}
      {guestShare ? (
        <span>Pending: {pendingReviewCount}</span>
      ) : (
        <button
          type="button"
          className="ui-control status-chip"
          onClick={() => onOpenTab("impact")}
        >
          Pending: {pendingReviewCount}
        </button>
      )}
      {unmappedCount > 0 &&
        (guestShare ? (
          <span>{unmappedPendingLabel(unmappedCount)}</span>
        ) : (
          <button
            type="button"
            className="ui-control status-chip"
            onClick={() => onOpenTab("impact")}
          >
            {unmappedPendingLabel(unmappedCount)}
          </button>
        ))}
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
