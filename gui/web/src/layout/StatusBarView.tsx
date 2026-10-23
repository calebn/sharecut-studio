import type { ReactNode } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { StatusLiveRegion } from "../ui/StatusLiveRegion";
import { pendingEditsStatus, unmappedPendingStatus } from "../utils/edits";
import { plural } from "../utils/format";
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
  /** The project save state. */
  saveState?: ReactNode;
  reconcileHighlight?: boolean;
  job?: PipelineJobSnapshot | null;
  jobAction?: ReactNode;
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
  saveState,
  reconcileHighlight,
  job,
  jobAction,
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
      {saveState}
      {guestShare ? (
        <span>{pendingEditsStatus(pendingReviewCount)}</span>
      ) : (
        <button
          type="button"
          className="ui-control status-chip"
          onClick={() => onOpenTab("impact")}
        >
          {pendingEditsStatus(pendingReviewCount)}
        </button>
      )}
      {unmappedCount > 0 &&
        (guestShare ? (
          <span>{unmappedPendingStatus(unmappedCount)}</span>
        ) : (
          <button
            type="button"
            className="ui-control status-chip"
            onClick={() => onOpenTab("impact")}
          >
            {unmappedPendingStatus(unmappedCount)}
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
          {`${socialClipCount} social ${plural(socialClipCount, "clip")}`}
        </span>
      )}
      {transcriptNeedsSync ? (
        <span className={reconcileHighlight ? "stale-highlight" : undefined}>
          Transcript needs sync
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
      {jobAction}
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
