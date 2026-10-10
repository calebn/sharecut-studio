import { memo, useEffect, useMemo, useRef, useState } from "react";
import { runPointerCommand } from "../commands/pointer";
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
import { InspectorPeek } from "../inspector/InspectorPeek";
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
import { isPipelineSlotBusy } from "../utils/pipeline";
import { BottomTabsSplitter } from "./BottomTabsSplitter";
import { EditingToolRail } from "./EditingToolRail";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { HomeScreenHint } from "./HomeScreenHint";
import { MobileShell } from "./MobileShell";
import { StatusBar } from "./StatusBar";
import { StudioShellView, type StudioWorkspace } from "./StudioShellView";
import { TransportBar } from "./TransportBar";
import { compactSheetProps, useCompactInspector } from "./useCompactInspector";

function StudioShellAdapter({ guestShare = false }: { guestShare?: boolean }) {
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
    layoutMode,
    sheetExpanded,
    setSheetExpanded,
    guestMode,
    projectPath,
    shareCapabilities,
    followingClientId,
  } = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    setSelection: s.setSelection,
    activeTab: s.activeTab,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    setTimelineFocused: s.setTimelineFocused,
    setShellBreakpoint: s.setShellBreakpoint,
    layoutMode: s.layoutMode,
    sheetExpanded: s.sheetExpanded,
    setSheetExpanded: s.setSheetExpanded,
    guestMode: s.guestMode,
    projectPath: s.projectPath,
    shareCapabilities: s.shareCapabilities,
    followingClientId: s.followingClientId,
  }));

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
    if (layoutMode === "default") {
      delete root.dataset.layout;
    } else {
      root.dataset.layout = layoutMode;
    }
  }, [shell, layoutMode, setShellBreakpoint]);

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
  const compact = useCompactInspector(shell === "tablet" ? "tablet" : null);

  if (shell === "phone") {
    return <MobileShell guestShare={guestShare} />;
  }

  const useSheetInspector = shell === "tablet";
  const showInspector =
    !useSheetInspector &&
    selection != null &&
    selection.kind !== "range" &&
    selection.kind !== "transcriptRange";
  // Peek sheet shares the bottom band with tabs; hide it when text/review
  // focus expands that band so Transcript/Comments stay fully readable.
  const sheetOpen =
    useSheetInspector &&
    selection != null &&
    layoutMode !== "text" &&
    layoutMode !== "review";
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
      appearance={{ guestShare, following: Boolean(followingClientId) }}
      layout={layoutMode}
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
              <HomeScreenHint />
            </>
          ),
          follow: <FollowBanner />,
        },
        transport: (
          <>
            <TransportBar compact={shell === "tablet"} showLayout />
            <RangeActions />
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
        content: panelContent,
        onTabChange: (tab) => runPointerCommand("view.setTab", { tab }),
      }}
      inspector={
        useSheetInspector
          ? {
              kind: "tablet",
              tools: (
                <EditingToolRail
                  inert={sheetOpen && compact != null && !compact.stowed}
                />
              ),
              sheet: {
                open: sheetOpen,
                expanded: sheetExpanded,
                content:
                  compact?.view === "peek" ? (
                    <InspectorPeek peek={compact.peek} />
                  ) : (
                    <Inspector />
                  ),
                onClose: () => {
                  setSelection(null);
                  setSheetExpanded(false);
                },
                onExpandedChange: setSheetExpanded,
                compact: compact ? compactSheetProps(compact) : undefined,
              },
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
