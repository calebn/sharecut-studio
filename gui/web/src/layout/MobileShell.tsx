import { useEffect, useRef } from "react";
import { execute } from "../commands/execute";
import { FEATURE_SHARE_UI_BANNER } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useTimelineFocusRegion } from "../hooks/useTimelineFocusRegion";
import { Inspector } from "../inspector/Inspector";
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
import { canIngestMedia, guestShareBannerLabel } from "../shareMode";
import type { MobileMode } from "../state/types";
import { useDaw } from "../state/useDaw";
import { TimelineView } from "../timeline/TimelineView";
import { TrackHeadersColumn } from "../tracks/TrackHeadersColumn";
import type { PresenceTab } from "../types/session";
import { BottomSheet, CommandButton, ToggleButton } from "../ui";
import { isPipelineSlotBusy, pipelineChipOpensPanel } from "../utils/pipeline";
import { formatTimecodePair } from "../utils/time";
import { AvatarStack } from "./AvatarStack";
import { EditingToolRail } from "./EditingToolRail";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { OverlayLegend } from "./OverlayLegend";
import { PipelineStatusChip } from "./PipelineStatusChip";
import { TransportBar } from "./TransportBar";
import { TAB_LABELS } from "./tabLabels";

const MODES: { id: MobileMode; label: string }[] = [
  { id: "listen", label: "Listen" },
  { id: "timeline", label: "Timeline" },
  { id: "text", label: "Text" },
  { id: "more", label: "More" },
];

function MoreHub({ guestShare }: { guestShare: boolean }) {
  const {
    pipelineJob,
    activityJob,
    projectPath,
    guestMode,
    shareCapabilities,
    project,
    setGesturesSheetOpen,
  } = useDaw();
  const running =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
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
                    void execute(
                      "view.setMobileMode",
                      { mode: "more", destination: id },
                      { skipWhen: true },
                    )
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
              No tracks yet — Import Audio adds one dialogue track per file.
            </p>
          ) : null}
          <CommandButton commandId="media.import">Import Audio…</CommandButton>
          <CommandButton commandId="track.add">New Track</CommandButton>
        </div>
      ) : null}
      <div className="mobile-more-settings">
        <OverlayLegend />
      </div>
      <div className="mobile-more-settings">
        <button
          type="button"
          className="mobile-more-item"
          onClick={() => setGesturesSheetOpen(true)}
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

function seekListen(sec: number): void {
  void execute("transport.seek", { sec }, { skipWhen: true });
}

function ListenMode({ guestShare }: { guestShare: boolean }) {
  const {
    project,
    playheadSec,
    isPlaying,
    setActiveTab,
    setSelection,
    pipelineJob,
    activityJob,
    activityRunningCount,
  } = useDaw();

  if (!project) {
    return (
      <div className="mobile-listen" aria-busy="true">
        <h1 className="sr-only">Loading episode…</h1>
        <div className="mobile-listen-transport">
          <CommandButton
            bare
            commandId="transport.togglePlay"
            className="play-btn mobile-play-lg"
            aria-label="Play"
            disabled
            {...presenceAnchorProps(presenceAnchor("transport", "play"))}
          >
            Play
          </CommandButton>
          <CommandButton
            bare
            commandId="transport.stop"
            className="stop-btn"
            aria-label="Stop"
            disabled
          >
            ■
          </CommandButton>
          <span className="timecode">{formatTimecodePair(0, 0)}</span>
        </div>
        <p>Loading episode…</p>
      </div>
    );
  }

  const duration = project.timeline_duration_sec;
  const comments = [...(project.comments ?? [])].sort(
    (a, b) => a.timeline_start - b.timeline_start,
  );
  const pending = project.edit_impact.pending_review_count;
  const stale =
    project.render_status.needs_rerender ||
    project.render_status.reconciliation.stale;
  const chipJob = activityJob ?? pipelineJob;

  return (
    <div className="mobile-listen">
      <h1 className="sr-only">{project.meta.name}</h1>
      <div className="mobile-listen-transport">
        <CommandButton
          bare
          commandId="transport.togglePlay"
          className="play-btn mobile-play-lg"
          {...presenceAnchorProps(presenceAnchor("transport", "play"))}
        >
          {isPlaying ? "Pause" : "Play"}
        </CommandButton>
        <CommandButton
          bare
          commandId="transport.stop"
          className="stop-btn"
          {...presenceAnchorProps(presenceAnchor("transport", "stop"))}
        >
          ■
        </CommandButton>
        <span className="timecode">
          {formatTimecodePair(playheadSec, duration)}
        </span>
      </div>
      <input
        type="range"
        className="mobile-scrub"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        value={Math.min(playheadSec, duration)}
        aria-label="Scrub timeline"
        onChange={(e) => seekListen(Number(e.target.value))}
      />
      <div className="mobile-nudge">
        <button
          type="button"
          onClick={() => seekListen(Math.max(0, playheadSec - 15))}
        >
          −15s
        </button>
        <button
          type="button"
          onClick={() => seekListen(Math.min(duration, playheadSec + 15))}
        >
          +15s
        </button>
      </div>
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
              void execute(
                "view.setMobileMode",
                { mode: "timeline" },
                { skipWhen: true },
              );
            }}
          >
            Pending: {pending}
          </button>
        ) : null}
        {stale ? (
          <span className="status-chip warning">Stale render</span>
        ) : null}
        {chipJob ? (
          <PipelineStatusChip
            job={chipJob}
            runningCount={activityRunningCount}
            headlineMax={28}
            onClick={
              !guestShare && pipelineChipOpensPanel(chipJob)
                ? () => {
                    void execute(
                      "view.setMobileMode",
                      { mode: "more", destination: "pipeline" },
                      { skipWhen: true },
                    );
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
              void execute(
                "view.setMobileMode",
                { mode: "more", destination: "comments" },
                { skipWhen: true },
              );
            }}
          >
            Open all
          </button>
        </div>
        {comments.length === 0 ? (
          <p className="mobile-empty">No comments yet</p>
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

export function MobileShell({ guestShare = false }: { guestShare?: boolean }) {
  const {
    selection,
    setSelection,
    mobileMode,
    moreDestination,
    setMoreDestination,
    sheetExpanded,
    setSheetExpanded,
    setTimelineFocused,
    guestMode,
    followingClientId,
    statusAnnouncement,
  } = useDaw();
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

  return (
    <div
      ref={shellRef}
      className={`daw-shell daw-shell--phone${mobileMode === "listen" ? " daw-shell--listen" : ""}${guestShare ? " daw-shell-guest" : ""}${followingClientId ? " daw-shell--following" : ""}`}
      data-shell="phone"
    >
      <Slot id={FEATURE_SHARE_UI_BANNER}>
        {guestShare ? (
          <div className="daw-shell-banners">
            <div className="guest-banner" role="status">
              {guestShareBannerLabel(guestMode)}
            </div>
            <GuestAttentionBanner />
          </div>
        ) : null}
      </Slot>
      <FollowBanner />
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusAnnouncement}
      </span>
      {mobileMode !== "listen" ? (
        <div ref={transportFocusRef}>
          <TransportBar compact showFit />
        </div>
      ) : null}
      <main className="mobile-mode-body">
        {mobileMode === "listen" && <ListenMode guestShare={guestShare} />}
        {mobileMode === "timeline" && (
          <div className="mobile-timeline-mode">
            <TimelineView fixedPlayhead headerSlot={<TrackHeadersColumn />} />
            <EditingToolRail />
          </div>
        )}
        {mobileMode === "text" && (
          <div ref={textFocusRef} className="mobile-text-mode">
            <TranscriptPanel />
          </div>
        )}
        {mobileMode === "more" && (
          <div ref={moreFocusRef} className="mobile-more-mode">
            {moreDestination === "hub" && <MoreHub guestShare={guestShare} />}
            {moreDestination === "comments" && (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => setMoreDestination("hub")}
                >
                  ← More
                </button>
                <CommentsPanel guestShare={guestShare} />
              </>
            )}
            {!guestShare && moreDestination === "history" && (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => setMoreDestination("hub")}
                >
                  ← More
                </button>
                <HistoryPanel />
              </>
            )}
            {!guestShare && moreDestination === "impact" && (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => setMoreDestination("hub")}
                >
                  ← More
                </button>
                <ImpactPanel />
              </>
            )}
            {!guestShare && moreDestination === "tighten" && (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => setMoreDestination("hub")}
                >
                  ← More
                </button>
                <TightenPanel />
              </>
            )}
            {!guestShare && moreDestination === "pipeline" && (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => setMoreDestination("hub")}
                >
                  ← More
                </button>
                <PipelinePanel />
              </>
            )}
          </div>
        )}
      </main>
      <nav className="mobile-nav" aria-label="Primary">
        {MODES.map(({ id, label }) => (
          <ToggleButton
            key={id}
            pressed={mobileMode === id}
            {...presenceAnchorProps(presenceAnchor("mobile-nav", id))}
            onClick={() =>
              void execute(
                "view.setMobileMode",
                { mode: id },
                { skipWhen: true },
              )
            }
          >
            {label}
          </ToggleButton>
        ))}
      </nav>
      <BottomSheet
        open={
          selection != null &&
          (mobileMode === "timeline" || mobileMode === "listen")
        }
        onClose={closeSheet}
        title="Inspector"
        expanded={sheetExpanded}
        onExpandedChange={setSheetExpanded}
      >
        <Inspector />
      </BottomSheet>
      <PresenceGhostLayer rootRef={shellRef} />
    </div>
  );
}
