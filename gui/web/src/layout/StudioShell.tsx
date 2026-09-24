import { useEffect, useRef, useState } from "react";
import { execute } from "../commands/execute";
import { FEATURE_SHARE_UI_BANNER } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useTimelineFocusRegion } from "../hooks/useTimelineFocusRegion";
import { useViewportClass } from "../hooks/useViewportClass";
import {
  audioFilesFromDrop,
  dismissIngestCoach,
  fileCountFromDataTransfer,
  isIngestCoachDismissed,
  newTracksDropLabel,
} from "../ingest/dropLabels";
import { ingestFiles } from "../ingest/ingestFiles";
import { Inspector } from "../inspector/Inspector";
import { displayShortcutFor } from "../keymap/registry";
import { CommentsPanel } from "../panels/CommentsPanel";
import { HistoryPanel } from "../panels/HistoryPanel";
import { ImpactPanel } from "../panels/ImpactPanel";
import { PipelinePanel } from "../panels/PipelinePanel";
import { TightenPanel } from "../panels/TightenPanel";
import { TranscriptPanel } from "../panels/TranscriptPanel";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { studioTabIds } from "../presence/followSync";
import { PresenceGhostLayer } from "../presence/PresenceGhostLayer";
import { usePresenceCursorSource } from "../presence/usePresenceCursorSource";
import { canIngestMedia, guestShareBannerLabel } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { TimelineView } from "../timeline/TimelineView";
import { TrackHeadersColumn } from "../tracks/TrackHeadersColumn";
import { BottomSheet, FocusToggle, ToggleButton } from "../ui";
import { isPipelineSlotBusy } from "../utils/pipeline";
import { BottomTabsSplitter } from "./BottomTabsSplitter";
import { EditingToolRail } from "./EditingToolRail";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { MobileShell } from "./MobileShell";
import { StatusBar } from "./StatusBar";
import { TransportBar } from "./TransportBar";
import { TAB_LABELS } from "./tabLabels";

export function StudioShell({ guestShare = false }: { guestShare?: boolean }) {
  const importShortcut = displayShortcutFor("media.import") ?? "Menu";
  const {
    project,
    selection,
    setSelection,
    activeTab,
    pipelineJob,
    activityJob,
    setTimelineFocused,
    setShellBreakpoint,
    focusMode,
    sheetExpanded,
    setSheetExpanded,
    guestMode,
    projectPath,
    shareCapabilities,
    followingClientId,
  } = useDaw();

  const shell = useViewportClass();
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const loadingSession = project == null;
  const emptySession = !loadingSession && (project?.tracks.length ?? 0) === 0;
  const [addDropOver, setAddDropOver] = useState(false);
  const [addFileCount, setAddFileCount] = useState(1);
  const [coachOpen, setCoachOpen] = useState(() => !isIngestCoachDismissed());
  const transportFocusRef = useTimelineFocusRegion<HTMLDivElement>(
    true,
    setTimelineFocused,
  );
  const mainFocusRef = useTimelineFocusRegion<HTMLElement>(
    true,
    setTimelineFocused,
  );
  const panelsFocusRef = useTimelineFocusRegion<HTMLElement>(
    false,
    setTimelineFocused,
  );
  const shellRef = useRef<HTMLDivElement>(null);
  usePresenceCursorSource(shellRef);

  useEffect(() => {
    setShellBreakpoint(shell);
    if (typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    root.dataset.shell = shell;
    if (focusMode === "default") {
      delete root.dataset.focus;
    } else {
      root.dataset.focus = focusMode;
    }
  }, [shell, focusMode, setShellBreakpoint]);

  useEffect(() => {
    return () => {
      if (typeof document === "undefined") {
        return;
      }
      delete document.documentElement.dataset.shell;
      delete document.documentElement.dataset.focus;
    };
  }, []);

  const pipelineRunning =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);

  const tabs = studioTabIds(guestShare);

  if (shell === "phone") {
    return <MobileShell guestShare={guestShare} />;
  }

  const useSheetInspector = shell === "tablet";
  // Peek sheet shares the bottom band with tabs; hide it when text/review
  // focus expands that band so Transcript/Comments stay fully readable.
  const sheetOpen =
    useSheetInspector &&
    selection != null &&
    focusMode !== "text" &&
    focusMode !== "review";
  // Only the ingest drop target keeps headers outside the timeline; any drawn
  // timeline hosts them so both read one TimelineMetricsProvider and align.
  const showIngestTarget = emptySession && mayIngest;
  const arranging = !loadingSession && !showIngestTarget;

  const trackHeaders = (
    <TrackHeadersColumn
      showFocusToggle
      showAddTrack
      addDropOver={addDropOver}
      addFileCount={addFileCount}
      onAddDropOverChange={(over, fileCount) => {
        setAddDropOver(over);
        if (fileCount != null) {
          setAddFileCount(fileCount);
        }
      }}
    />
  );

  return (
    <div
      ref={shellRef}
      className={[
        "daw-shell",
        guestShare ? "daw-shell-guest" : "",
        !guestShare ? "daw-shell--attention" : "",
        followingClientId ? "daw-shell--following" : "",
        `daw-shell--${shell}`,
        focusMode !== "default" ? `daw-shell--focus-${focusMode}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-shell={shell}
    >
      <div className="daw-shell-banners">
        <Slot id={FEATURE_SHARE_UI_BANNER}>
          {guestShare ? (
            <div className="guest-banner" role="status">
              {guestShareBannerLabel(guestMode)}
            </div>
          ) : null}
        </Slot>
        <GuestAttentionBanner />
      </div>
      <FollowBanner />
      <div ref={transportFocusRef}>
        <TransportBar compact={shell === "tablet"} />
      </div>
      <main
        ref={mainFocusRef}
        className={["daw-main", arranging ? "daw-main--arrange" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {loadingSession ? (
          <>
            {trackHeaders}
            <TimelineView />
          </>
        ) : showIngestTarget ? (
          <>
            {trackHeaders}
            <div className="empty-session-wrap">
              <button
                type="button"
                className={`empty-session-drop${addDropOver ? " lane-drop-target" : ""}`}
                aria-label="Drop audio files or import"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setAddFileCount(
                    Math.max(1, fileCountFromDataTransfer(e.dataTransfer)),
                  );
                  setAddDropOver(true);
                }}
                onDragLeave={() => setAddDropOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setAddDropOver(false);
                  const files = audioFilesFromDrop(e.dataTransfer.files);
                  if (files.length) {
                    void ingestFiles(files, { kind: "new" });
                  }
                }}
                onClick={() => {
                  void execute("media.import", {}, { skipWhen: true });
                }}
              >
                <span className="empty-session-ghost" aria-hidden="true" />
                <span className="empty-session-drop-label">
                  {addDropOver
                    ? newTracksDropLabel(addFileCount)
                    : `Drop audio files here, or Import Audio (${importShortcut})`}
                </span>
              </button>
              {coachOpen ? (
                <div className="box elevated empty-session-coach" role="status">
                  <p>
                    Drop stems here. Use one file per speaker. Import is also
                    under Menu ({importShortcut}).
                  </p>
                  <button
                    type="button"
                    className="empty-session-coach-dismiss"
                    onClick={() => {
                      dismissIngestCoach();
                      setCoachOpen(false);
                    }}
                  >
                    Got it
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <TimelineView headerSlot={trackHeaders} />
        )}
        {useSheetInspector ? <EditingToolRail /> : null}
        {!useSheetInspector ? <Inspector /> : null}
      </main>
      <section
        ref={panelsFocusRef}
        className="bottom-tabs"
        aria-label="Editor panels"
      >
        <BottomTabsSplitter />
        <div className="tab-bar">
          {tabs.map((id) => (
            <ToggleButton
              key={id}
              quiet
              pressed={activeTab === id}
              data-ui-kind="tab"
              {...presenceAnchorProps(presenceAnchor("tab", id))}
              onClick={() =>
                void execute("view.setTab", { tab: id }, { skipWhen: true })
              }
            >
              {TAB_LABELS[id]}
              {id === "pipeline" && pipelineRunning ? " ●" : ""}
            </ToggleButton>
          ))}
          {activeTab === "comments" ? (
            <div className="tab-bar-focus">
              <FocusToggle mode="review" label="Comments" />
            </div>
          ) : null}
        </div>
        <div className="tab-content">
          {activeTab === "transcript" && <TranscriptPanel />}
          {activeTab === "comments" && (
            <CommentsPanel guestShare={guestShare} />
          )}
          {!guestShare && activeTab === "history" && <HistoryPanel />}
          {!guestShare && activeTab === "impact" && <ImpactPanel />}
          {!guestShare && activeTab === "tighten" && <TightenPanel />}
          {!guestShare && activeTab === "pipeline" && <PipelinePanel />}
        </div>
      </section>
      <StatusBar guestShare={guestShare} />
      {useSheetInspector ? (
        <BottomSheet
          open={sheetOpen}
          onClose={() => {
            setSelection(null);
            setSheetExpanded(false);
          }}
          title="Inspector"
          expanded={sheetExpanded}
          onExpandedChange={setSheetExpanded}
        >
          <Inspector />
        </BottomSheet>
      ) : null}
      <PresenceGhostLayer rootRef={shellRef} />
    </div>
  );
}
