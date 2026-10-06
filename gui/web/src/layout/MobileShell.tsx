import { memo, useEffect, useMemo, useRef, useState } from "react";
import { runPointerCommand } from "../commands/pointer";
import { FEATURE_SHARE_UI_BANNER } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useJobStatusAnnouncement } from "../hooks/useJobStatusAnnouncement";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { useTimelineFocusRegion } from "../hooks/useTimelineFocusRegion";
import { useTwoFingerTap } from "../hooks/useTwoFingerTap";
import { Inspector } from "../inspector/Inspector";
import { RelatedCommands } from "../inspector/RelatedCommands";
import { CommentsPanel } from "../panels/CommentsPanel";
import { HistoryPanel } from "../panels/HistoryPanel";
import { ImpactPanel } from "../panels/ImpactPanel";
import { PipelinePanel } from "../panels/PipelinePanel";
import { TightenPanel } from "../panels/TightenPanel";
import { TranscriptPanel } from "../panels/TranscriptPanel";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isHostOnlyTab } from "../presence/followSync";
import { PresenceGhostLayer } from "../presence/PresenceGhostLayer";
import { usePresenceCursorSource } from "../presence/usePresenceCursorSource";
import { RecordTransportChip } from "../record/RecordTransportChip";
import {
  canApplyPass12,
  canIngestMedia,
  canManageProjects,
  guestShareBannerLabel,
} from "../shareMode";
import { useDaw } from "../state/useDaw";
import { RangeActions } from "../timeline/RangeActions";
import { TimelineView } from "../timeline/TimelineView";
import { SoloChip } from "../tracks/SoloChip";
import { TrackHeadersColumn } from "../tracks/TrackHeadersColumn";
import { TrackMix } from "../tracks/TrackMix";
import type { PresenceTab } from "../types/session";
import { CommandButton, EmptyState, Timecode } from "../ui";
import { isPipelineSlotBusy, pipelineChipOpensPanel } from "../utils/pipeline";
import { MIX_STALE_LABEL } from "../utils/staleRender";
import { formatTimecodePair, transportTimecode } from "../utils/time";
import { AvatarStack } from "./AvatarStack";
import { EditingToolRail } from "./EditingToolRail";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { ListenHero } from "./ListenHero";
import { ListenScrubber } from "./ListenPlayhead";
import { LISTEN_SKIP_SEC, seekListen, skipListen } from "./listenSeek";
import {
  type MobileScreen,
  type MobileSheet,
  MobileShellView,
} from "./MobileShellView";
import { OverlayLegend } from "./OverlayLegend";
import { PipelineStatusChip } from "./PipelineStatusChip";
import { TransportBar } from "./TransportBar";
import { TransportPlayControls } from "./TransportPlayControls";
import { TransportTimecode } from "./TransportTimecode";
import { TAB_LABELS } from "./tabLabels";
import { transportPlayHandlers } from "./transportPlay";

function MoreHub({
  guestShare,
  onOpenMix,
  onOpenGestures,
}: {
  guestShare: boolean;
  onOpenMix: () => void;
  onOpenGestures: () => void;
}) {
  const {
    pipelineJob,
    activityJob,
    projectPath,
    guestMode,
    shareCapabilities,
    project,
  } = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    project: s.project,
  }));
  const running =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayManage = canManageProjects(projectPath);
  const emptySession = project != null && (project.tracks.length ?? 0) === 0;
  const items: Exclude<PresenceTab, "transcript">[] = [
    "comments",
    "history",
    "impact",
    "tighten",
    "pipeline",
  ];

  return (
    <div className="mobile-more-hub" aria-label="More">
      <ul className="mobile-more-list">
        <li>
          <button
            type="button"
            className="mobile-more-item"
            onClick={onOpenMix}
          >
            Mix
          </button>
        </li>
        {items
          .filter((id) => !isHostOnlyTab(id) || !guestShare)
          .map((id) => {
            const label =
              id === "pipeline" && running
                ? `${TAB_LABELS.pipeline} ●`
                : TAB_LABELS[id];
            return (
              <li key={id}>
                <button
                  type="button"
                  className="mobile-more-item"
                  {...presenceAnchorProps(presenceAnchor("tab", id))}
                  onClick={() =>
                    runPointerCommand("view.setMobileMode", {
                      mode: "more",
                      destination: id,
                    })
                  }
                >
                  {label}
                </button>
              </li>
            );
          })}
      </ul>
      {mayIngest ? (
        <div className="mobile-more-settings">
          {emptySession ? (
            <p className="mobile-ingest-hint">
              No tracks yet. Import Audio adds one dialogue track per file.
            </p>
          ) : null}
          <CommandButton commandId="media.import">Import Audio…</CommandButton>
          <CommandButton commandId="track.add">New Track</CommandButton>
        </div>
      ) : null}
      <div className="mobile-more-settings">
        <OverlayLegend />
      </div>
      {mayManage ? (
        <div className="mobile-more-settings">
          <CommandButton commandId="edit.addChapter" respectWhen>
            Add chapter at playhead
          </CommandButton>
        </div>
      ) : null}
      <div className="mobile-more-settings">
        <button
          type="button"
          className="mobile-more-item"
          onClick={onOpenGestures}
        >
          Gestures
        </button>
      </div>
      <div role="menu" aria-label="People">
        <AvatarStack variant="menu" />
      </div>
    </div>
  );
}

function ListenMode({ guestShare }: { guestShare: boolean }) {
  const {
    project,
    isPlaying,
    setActiveTab,
    setSelection,
    pipelineJob,
    activityJob,
    activityRunningCount,
  } = useDaw((s) => ({
    project: s.project,
    isPlaying: s.isPlaying,
    setActiveTab: s.setActiveTab,
    setSelection: s.setSelection,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
  }));
  const stale = useStaleRenderBreakdown(project).stale;

  if (!project) {
    return (
      <div className="mobile-listen" aria-busy="true">
        <ListenHero
          title="Loading episode…"
          controls={
            <TransportPlayControls
              playing={false}
              disabled
              {...transportPlayHandlers}
            />
          }
          timecode={<Timecode current={transportTimecode(0, 0).current} />}
          scrubber={null}
        />
      </div>
    );
  }

  const duration = project.timeline_duration_sec;
  const emptyProject = project.tracks.length === 0;
  const comments = [...(project.comments ?? [])].sort(
    (a, b) => a.timeline_start - b.timeline_start,
  );
  const pending = project.edit_impact.pending_review_count;
  const chipJob = activityJob ?? pipelineJob;

  return (
    <div className="mobile-listen">
      <ListenHero
        title={project.meta.name}
        playing={isPlaying}
        controls={
          <TransportPlayControls
            playing={isPlaying}
            disabled={emptyProject}
            disabledTitle="Import audio to play"
            {...transportPlayHandlers}
          />
        }
        timecode={<TransportTimecode durationSec={duration} />}
        scrubber={<ListenScrubber durationSec={duration} />}
        skipBack={
          <button
            type="button"
            onClick={() => skipListen(-LISTEN_SKIP_SEC, duration)}
          >
            {`−${LISTEN_SKIP_SEC}s`}
          </button>
        }
        skipForward={
          <button
            type="button"
            onClick={() => skipListen(LISTEN_SKIP_SEC, duration)}
          >
            {`+${LISTEN_SKIP_SEC}s`}
          </button>
        }
      />
      <div className="mobile-status-chips">
        {pending > 0 ? (
          <button
            type="button"
            className="ui-control status-chip"
            onClick={() => {
              const first =
                project.pending_edits.find((e) => e.review_required) ??
                project.pending_edits[0];
              if (first) {
                setSelection({
                  kind: "pending",
                  id: first.id,
                  trackId: first.track_id,
                });
              }
              runPointerCommand("view.setMobileMode", {
                mode: "timeline",
              });
            }}
          >
            Pending: {pending}
          </button>
        ) : null}
        {stale ? (
          <span className="status-chip warning">{MIX_STALE_LABEL}</span>
        ) : null}
        {chipJob ? (
          <PipelineStatusChip
            job={chipJob}
            runningCount={activityRunningCount}
            headlineMax={28}
            onClick={
              !guestShare && pipelineChipOpensPanel(chipJob)
                ? () => {
                    runPointerCommand("view.setMobileMode", {
                      mode: "more",
                      destination: "pipeline",
                    });
                  }
                : undefined
            }
          />
        ) : null}
      </div>
      <div className="mobile-comment-list">
        <div className="mobile-comment-list-head">
          <h2>Comments</h2>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              runPointerCommand("view.setMobileMode", {
                mode: "more",
                destination: "comments",
              });
            }}
          >
            Open all
          </button>
        </div>
        {comments.length === 0 ? (
          <EmptyState>No comments yet.</EmptyState>
        ) : (
          <ul>
            {comments.slice(0, 40).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="mobile-comment-row"
                  onClick={() => {
                    seekListen(c.timeline_start);
                    setActiveTab("comments");
                  }}
                >
                  <span className="mobile-comment-time">
                    {
                      formatTimecodePair(c.timeline_start, duration).split(
                        " / ",
                      )[0]
                    }
                  </span>
                  <span className="mobile-comment-body">
                    {c.body.slice(0, 80)}
                    {c.body.length > 80 ? "…" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MobileShellAdapter({ guestShare = false }: { guestShare?: boolean }) {
  const {
    rangeArmed,
    setRangeArmed,
    selection,
    setSelection,
    mobileMode,
    moreDestination,
    setMoreDestination,
    sheetExpanded,
    setSheetExpanded,
    setTimelineFocused,
    guestMode,
    project,
    projectPath,
    shareCapabilities,
    followingClientId,
    statusAnnouncement,
    competingDialogOpen,
    setGesturesSheetOpen,
  } = useDaw((s) => ({
    rangeArmed: s.rangeArmed,
    setRangeArmed: s.setRangeArmed,
    selection: s.selection,
    setSelection: s.setSelection,
    mobileMode: s.mobileMode,
    moreDestination: s.moreDestination,
    setMoreDestination: s.setMoreDestination,
    sheetExpanded: s.sheetExpanded,
    setSheetExpanded: s.setSheetExpanded,
    setTimelineFocused: s.setTimelineFocused,
    guestMode: s.guestMode,
    project: s.project,
    projectPath: s.projectPath,
    shareCapabilities: s.shareCapabilities,
    followingClientId: s.followingClientId,
    statusAnnouncement: s.statusAnnouncement,
    competingDialogOpen:
      s.gesturesSheetOpen ||
      s.commandPaletteOpen ||
      s.bounceDialogOpen ||
      s.shareDialogOpen ||
      s.recordPanelOpen ||
      s.hostMcpDialogOpen ||
      s.helpDialogOpen,
    setGesturesSheetOpen: s.setGesturesSheetOpen,
  }));
  const [mixRequest, setMixRequest] = useState<{
    projectPath: string | null;
    followingClientId: string | null;
  } | null>(null);
  const mixEligible =
    mixRequest != null &&
    mixRequest.projectPath === projectPath &&
    mixRequest.followingClientId === followingClientId &&
    mobileMode === "more" &&
    moreDestination === "hub" &&
    selection == null &&
    !rangeArmed &&
    !competingDialogOpen;
  useEffect(() => {
    if (mixRequest && !mixEligible) setMixRequest(null);
  }, [mixRequest, mixEligible]);
  useJobStatusAnnouncement();
  const transportFocusRef = useTimelineFocusRegion<HTMLDivElement>(
    true,
    setTimelineFocused,
  );
  const textFocusRef = useTimelineFocusRegion<HTMLDivElement>(
    false,
    setTimelineFocused,
  );
  const moreFocusRef = useTimelineFocusRegion<HTMLDivElement>(
    false,
    setTimelineFocused,
  );
  const shellRef = useRef<HTMLDivElement>(null);
  // Stable element: the timeline it is slotted into skips re-rendering.
  const headerSlot = useMemo(() => <TrackHeadersColumn />, []);
  const undoEnabled =
    project != null &&
    canApplyPass12(projectPath, guestMode, shareCapabilities);
  useTwoFingerTap(shellRef, { enabled: undoEnabled });
  usePresenceCursorSource(shellRef);

  useEffect(() => {
    if (selection == null) {
      setSheetExpanded(false);
    }
  }, [selection, setSheetExpanded]);

  const closeSheet = () => {
    setSelection(null);
    setSheetExpanded(false);
  };

  const moreContent =
    moreDestination === "hub" ? (
      <MoreHub
        guestShare={guestShare}
        onOpenMix={() => {
          setRangeArmed(false);
          setSelection(null);
          setSheetExpanded(false);
          setMixRequest({ projectPath, followingClientId });
        }}
        onOpenGestures={() => {
          setMixRequest(null);
          setGesturesSheetOpen(true);
        }}
      />
    ) : moreDestination === "comments" ? (
      <CommentsPanel guestShare={guestShare} />
    ) : moreDestination === "history" ? (
      <HistoryPanel />
    ) : moreDestination === "impact" ? (
      <ImpactPanel />
    ) : moreDestination === "tighten" ? (
      <TightenPanel />
    ) : (
      <PipelinePanel />
    );
  const screen: MobileScreen =
    mobileMode === "listen"
      ? { kind: "listen", content: <ListenMode guestShare={guestShare} /> }
      : mobileMode === "timeline"
        ? {
            kind: "timeline",
            canvas: <TimelineView fixedPlayhead headerSlot={headerSlot} />,
            tools: <EditingToolRail />,
          }
        : mobileMode === "text"
          ? { kind: "text", content: <TranscriptPanel /> }
          : {
              kind: "more",
              destination: moreDestination,
              content: moreContent,
              onBack: () => {
                setMixRequest(null);
                setMoreDestination("hub");
              },
            };

  const inspectorOpen =
    rangeArmed ||
    (selection != null &&
      (mobileMode === "timeline" ||
        mobileMode === "listen" ||
        (mobileMode === "text" &&
          (selection.kind === "transcriptWord" ||
            selection.kind === "transcriptRange" ||
            selection.kind === "range")) ||
        (mobileMode === "more" &&
          moreDestination === "comments" &&
          selection.kind === "comment") ||
        (mobileMode === "more" &&
          moreDestination === "impact" &&
          selection.kind === "pending")));
  const sheet: MobileSheet = inspectorOpen
    ? {
        kind: "inspector",
        expanded: sheetExpanded,
        onExpandedChange: setSheetExpanded,
        onClose: () => {
          setRangeArmed(false);
          closeSheet();
        },
        content: (
          <>
            <Inspector />
            {rangeArmed ? (
              <RangeActions sheet />
            ) : (
              <RelatedCommands selection={selection} />
            )}
          </>
        ),
      }
    : mixEligible
      ? {
          kind: "mix",
          content: <TrackMix />,
          onClose: () => setMixRequest(null),
        }
      : { kind: "closed" };

  return (
    <MobileShellView
      appearance={{ guestShare, following: Boolean(followingClientId) }}
      chrome={{
        notices: {
          banners: (
            <>
              <Slot id={FEATURE_SHARE_UI_BANNER}>
                {guestShare ? (
                  <div className="guest-banner" role="status">
                    {guestShareBannerLabel(guestMode)}
                  </div>
                ) : null}
              </Slot>
              <GuestAttentionBanner />
            </>
          ),
          follow: <FollowBanner />,
        },
        announcement: statusAnnouncement,
        transport: <TransportBar compact showFit showStatusChips={false} />,
        status: (
          <>
            <RecordTransportChip />
            <SoloChip />
          </>
        ),
        overlay: <PresenceGhostLayer rootRef={shellRef} />,
      }}
      screen={screen}
      onModeChange={(mode) => {
        setMixRequest(null);
        runPointerCommand("view.setMobileMode", { mode });
      }}
      sheet={sheet}
      bindings={{
        root: shellRef,
        transport: transportFocusRef,
        text: textFocusRef,
        more: moreFocusRef,
      }}
    />
  );
}

/** Phone shell. */
export const MobileShell = memo(MobileShellAdapter);
