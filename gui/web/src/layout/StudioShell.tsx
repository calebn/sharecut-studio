import {
  memo,
  type RefCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runPointerCommand } from "../commands/pointer";
import { isRangeSelection } from "../edit/rangeSelection";
import { FEATURE_SHARE_UI_BANNER } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useRealignViewport } from "../hooks/useRealignViewport";
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
import { PresenceGhostLayer } from "../presence/PresenceGhostLayer";
import { usePresenceCursorSource } from "../presence/usePresenceCursorSource";
import { canIngestMedia, guestShareBannerLabel } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { RangeActions } from "../timeline/RangeActions";
import { TimelineView } from "../timeline/TimelineView";
import { TrackHeadersColumn } from "../tracks/TrackHeadersColumn";
import { writeDrawerCollapsed } from "../utils/drawerCollapsedPref";
import { isPipelineSlotBusy } from "../utils/pipeline";
import { oneWordOf } from "../utils/rangeSelect";
import { BottomTabsSplitter } from "./BottomTabsSplitter";
import { CollapsedDrawerHandle } from "./CollapsedDrawerHandle";
import { EditingToolRail } from "./EditingToolRail";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { GuestVersionNotice } from "./GuestVersionNotice";
import { HomeScreenHint } from "./HomeScreenHint";
import { type LoadFailure, LoadFailureBanner } from "./LoadFailureBanner";
import { MobileShell } from "./MobileShell";
import { StatusBar } from "./StatusBar";
import { StudioShellView, type StudioWorkspace } from "./StudioShellView";
import { TransportBar } from "./TransportBar";
import { useSelectionSheet } from "./useSelectionSheet";

function StudioShellAdapter({
  guestShare = false,
  feedbackHostRef,
  attentionHost,
  loadFailure,
}: {
  guestShare?: boolean;
  feedbackHostRef?: RefCallback<HTMLDivElement>;
  attentionHost?: HTMLElement | null;
  loadFailure?: LoadFailure | null;
}) {
  const importShortcut = displayShortcutFor("media.import") ?? "Menu";
  const {
    project,
    selection,
    activeTab,
    pipelineJob,
    activityJob,
    setTimelineFocused,
    setShellBreakpoint,
    layoutMode,
    guestMode,
    projectPath,
    shareCapabilities,
    followingClientId,
  } = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    activeTab: s.activeTab,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    setTimelineFocused: s.setTimelineFocused,
    setShellBreakpoint: s.setShellBreakpoint,
    layoutMode: s.layoutMode,
    guestMode: s.guestMode,
    projectPath: s.projectPath,
    shareCapabilities: s.shareCapabilities,
    followingClientId: s.followingClientId,
  }));

  const shell = useViewportClass();
  useRealignViewport();
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
    if (layoutMode === "default") {
      delete root.dataset.layout;
    } else {
      root.dataset.layout = layoutMode;
    }
  }, [shell, layoutMode, setShellBreakpoint]);

  const lastShell = useRef(shell);
  useEffect(() => {
    // The phone has no layouts and resets to the default one, and so does a
    // return from it. Neither is a choice, so neither may forget what a
    // tablet or desktop left collapsed.
    const switched = lastShell.current !== shell;
    lastShell.current = shell;
    if (shell !== "phone" && !switched) {
      writeDrawerCollapsed(layoutMode === "timeline");
    }
  }, [shell, layoutMode]);

  useEffect(() => {
    return () => {
      if (typeof document === "undefined") {
        return;
      }
      delete document.documentElement.dataset.shell;
      delete document.documentElement.dataset.layout;
    };
  }, []);

  const pipelineRunning =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);

  // Memoized: a new element here would re-render the timeline it is slotted
  // into (headerSlot) on every shell render.
  const trackHeaders = useMemo(
    () => (
      <TrackHeadersColumn
        showAddTrack
        showSoloChip
        addDropOver={addDropOver}
        addFileCount={addFileCount}
        onAddDropOverChange={(over, fileCount) => {
          setAddDropOver(over);
          if (fileCount != null) {
            setAddFileCount(fileCount);
          }
        }}
      />
    ),
    [addDropOver, addFileCount],
  );
  const selectionSheet = useSelectionSheet(shell === "tablet" ? shell : null);

  if (shell === "phone") {
    return (
      <MobileShell
        guestShare={guestShare}
        feedbackHostRef={feedbackHostRef}
        attentionHost={attentionHost}
        loadFailure={loadFailure}
      />
    );
  }

  const showInspector =
    shell === "desktop" &&
    selection != null &&
    (!isRangeSelection(selection) || oneWordOf(selection) !== null);
  // Only the ingest drop target keeps headers outside the timeline; any drawn
  // timeline hosts them so both read one TimelineMetricsProvider and align.
  const showIngestTarget = emptySession && mayIngest;

  const workspace: StudioWorkspace = loadingSession
    ? { kind: "loading", headers: trackHeaders, canvas: <TimelineView /> }
    : showIngestTarget
      ? {
          kind: "ingest",
          headers: trackHeaders,
          ingest: {
            over: addDropOver,
            dropLabel: addDropOver
              ? newTracksDropLabel(addFileCount)
              : `Drop audio files here, or Import Audio (${importShortcut})`,
            importShortcut,
            coachOpen,
            onDragOver: (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setAddFileCount(
                Math.max(1, fileCountFromDataTransfer(e.dataTransfer)),
              );
              setAddDropOver(true);
            },
            onDragLeave: () => setAddDropOver(false),
            onDrop: (e) => {
              e.preventDefault();
              setAddDropOver(false);
              const files = audioFilesFromDrop(e.dataTransfer.files);
              if (files.length) void ingestFiles(files, { kind: "new" });
            },
            onImport: () => runPointerCommand("media.import", {}),
            onDismissCoach: () => {
              dismissIngestCoach();
              setCoachOpen(false);
            },
          },
        }
      : { kind: "arrange", canvas: <TimelineView headerSlot={trackHeaders} /> };
  const panelContent =
    activeTab === "transcript" ? (
      <TranscriptPanel />
    ) : activeTab === "comments" ? (
      <CommentsPanel guestShare={guestShare} />
    ) : activeTab === "history" ? (
      <HistoryPanel />
    ) : activeTab === "impact" ? (
      <ImpactPanel />
    ) : activeTab === "tighten" ? (
      <TightenPanel />
    ) : (
      <PipelinePanel />
    );

  return (
    <StudioShellView
      feedbackHostRef={feedbackHostRef}
      appearance={{ guestShare, following: Boolean(followingClientId) }}
      layout={layoutMode}
      chrome={{
        notices: {
          banners: (
            <>
              <LoadFailureBanner failure={loadFailure} />
              <Slot id={FEATURE_SHARE_UI_BANNER}>
                {guestShare ? (
                  <div className="guest-banner" role="status">
                    {guestShareBannerLabel(guestMode)}
                  </div>
                ) : null}
              </Slot>
              {guestShare ? <GuestVersionNotice /> : null}
              <GuestAttentionBanner host={attentionHost} />
              <HomeScreenHint />
            </>
          ),
          follow: <FollowBanner />,
        },
        transport: (
          <>
            <TransportBar compact={shell === "tablet"} showLayout />
            {selectionSheet.rangeActionsInSheet ? null : <RangeActions />}
          </>
        ),
        footer: <StatusBar guestShare={guestShare} />,
        overlay: <PresenceGhostLayer rootRef={shellRef} />,
      }}
      workspace={workspace}
      panels={{
        activeTab,
        pipelineRunning,
        splitter: <BottomTabsSplitter />,
        reopenHandle: <CollapsedDrawerHandle />,
        content: panelContent,
        onTabChange: (tab) => runPointerCommand("view.setTab", { tab }),
      }}
      inspector={
        shell === "tablet"
          ? {
              kind: "tablet",
              tools: <EditingToolRail inert={selectionSheet.coversTools} />,
              sheet: selectionSheet,
            }
          : { kind: "desktop", content: showInspector ? <Inspector /> : null }
      }
      bindings={{
        root: shellRef,
        transport: transportFocusRef,
        main: mainFocusRef,
        panels: panelsFocusRef,
      }}
    />
  );
}

/** Desktop and tablet shell; the phone shell is `MobileShell`. */
export const StudioShell = memo(StudioShellAdapter);
