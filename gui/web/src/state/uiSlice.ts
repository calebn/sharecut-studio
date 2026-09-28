import type { StateCreator } from "zustand";
import { cssViewportWidth } from "../hooks/useViewportClass";
import type { ProjectView, Selection } from "../types/project";
import {
  readLaneHeightPref,
  stepLaneHeightPx,
  writeLaneHeightPref,
} from "../utils/laneHeightPref";
import {
  centerSecToScrollLeft,
  measureTimelineColumns,
  minLogicalScrollLeft,
  timelineTimeViewportWidth,
  viewportCenterOffsetPx,
} from "../utils/timelineViewport";
import {
  DEFAULT_WAVEFORM_VIEW_PREF,
  writeWaveformViewPref,
} from "../utils/waveformViewPref";
import {
  anchoredZoomScroll,
  clampWaveformAmp,
  clampZoomPxPerSec,
  discreteZoomFactor,
  fitZoomPxPerSec,
  MAX_WAVEFORM_AMP,
  MIN_WAVEFORM_AMP,
  sessionSecOf,
  visiblePlayheadClientX,
} from "../utils/zoom";
import {
  noteZoomPointerClientX,
  peekZoomPointerClientX,
} from "../utils/zoomPointer";
import { timelineViewportRegistry } from "./timelineViewportRegistry";
import type {
  CommentDraft,
  DawStore,
  DawTab,
  LaneHeightMode,
  LayerVisibility,
  LayoutMode,
  MobileMode,
  MoreDestination,
  PointerKind,
  ShellBreakpoint,
  ToolMode,
  TranscriptInlineEditFailure,
  TranscriptReviewCursor,
} from "./types";

function clipTrackId(
  project: ProjectView | null,
  clipId: string,
): string | null {
  if (!project) return null;
  for (const [trackId, list] of Object.entries(project.clips.tracks)) {
    if (list.some((c) => c.id === clipId)) return trackId;
  }
  return null;
}
/** Time-column width guess (px) for a shell whose timeline has not measured. */
export function estimateTimelineViewportWidth(bp: ShellBreakpoint): number {
  const w = cssViewportWidth();
  if (bp === "phone") return Math.max(200, w);
  if (bp === "tablet") return Math.max(200, w - 200);
  return Math.max(200, w - 500);
}

/** The one tab a layout shows: null for default (all tabs) and timeline (none). */
const LAYOUT_TAB: Readonly<Record<LayoutMode, DawTab | null>> = {
  default: null,
  timeline: null,
  text: "transcript",
  review: "comments",
};

/**
 * Switch to `activeTab`, restoring the default layout when the current layout
 * does not show that tab (timeline hides every tab; text/review show only
 * their own) so the requested panel is on screen. Leaving the timeline layout
 * this way also drops the timeline key focus that layout set.
 */
function revealTab(
  s: Pick<DawStore, "layoutMode">,
  activeTab: DawTab,
): Partial<DawStore> {
  if (s.layoutMode === "default" || LAYOUT_TAB[s.layoutMode] === activeTab) {
    return { activeTab };
  }
  return {
    activeTab,
    layoutMode: "default",
    ...(s.layoutMode === "timeline" ? { timelineFocused: false } : {}),
  };
}

/** Save the waveform view of the open project (per browser). */
function persistWaveformView(s: DawStore): void {
  writeWaveformViewPref(s.projectPath, {
    scale: s.waveformScale,
    amp: s.waveformAmpZoom,
    postFader: s.waveformPostFader,
  });
}

type UiSlice = Pick<
  DawStore,
  | "highlightStaleRender"
  | "renderPreviewBusy"
  | "ingestBusy"
  | "ingestDropTrackId"
  | "statusAnnouncement"
  | "pendingJobResults"
  | "setHighlightStaleRender"
  | "setRenderPreviewBusy"
  | "setIngestBusy"
  | "setIngestDropTrackId"
  | "announceStatus"
  | "expectJobResult"
  | "announceJobResult"
  | "settleJobResult"
  | "zoomPxPerSec"
  | "waveformAmpZoom"
  | "waveformScale"
  | "waveformPostFader"
  | "pointerTrackId"
  | "setPointerTrackId"
  | "bladeHoverSec"
  | "setBladeHoverSec"
  | "scrollLeft"
  | "timelineViewportWidth"
  | "setTimelineViewportWidth"
  | "resetTimelineViewportWidth"
  | "selection"
  | "activeTab"
  | "userZoomed"
  | "layers"
  | "commentMode"
  | "commentDraft"
  | "transcriptFollowPlayhead"
  | "transcriptInlineCommitPending"
  | "transcriptInlineEditFailure"
  | "transcriptReviewCursor"
  | "chapterAddPending"
  | "transcriptAnnotate"
  | "showCutAwayUtterances"
  | "timelineFocused"
  | "toolMode"
  | "selectedTrackIds"
  | "selectedClipIds"
  | "bladeConfirmSec"
  | "shellBreakpoint"
  | "pointerKind"
  | "mobileMode"
  | "moreDestination"
  | "layoutMode"
  | "sheetExpanded"
  | "laneHeightMode"
  | "laneHeightPx"
  | "drawnLaneHeightPx"
  | "setZoomPxPerSec"
  | "setWaveformAmpZoom"
  | "nudgeWaveformAmp"
  | "setWaveformScale"
  | "setWaveformPostFader"
  | "setScrollLeft"
  | "setSelection"
  | "selectClip"
  | "setActiveTab"
  | "setTranscriptFollowPlayhead"
  | "toggleTranscriptFollowPlayhead"
  | "setTranscriptInlineCommitPending"
  | "setTranscriptInlineEditFailure"
  | "setTranscriptReviewCursor"
  | "setChapterAddPending"
  | "setTranscriptAnnotate"
  | "toggleTranscriptAnnotate"
  | "setShowCutAwayUtterances"
  | "toggleShowCutAwayUtterances"
  | "setTimelineFocused"
  | "markUserZoomed"
  | "applyAnchoredZoom"
  | "setLayerVisible"
  | "setCommentMode"
  | "toggleCommentMode"
  | "setCommentDraft"
  | "setToolMode"
  | "setSelectedTrackIds"
  | "toggleTrackSelected"
  | "setBladeConfirmSec"
  | "setShellBreakpoint"
  | "setPointerKind"
  | "setMobileMode"
  | "setMoreDestination"
  | "setLayoutMode"
  | "setSheetExpanded"
  | "setLaneHeightMode"
  | "toggleFitTracksHeight"
  | "stepLaneHeight"
  | "setDrawnLaneHeightPx"
  | "commandPaletteOpen"
  | "setCommandPaletteOpen"
  | "gesturesSheetOpen"
  | "setGesturesSheetOpen"
  | "toggleCommandPalette"
  | "bounceDialogOpen"
  | "setBounceDialogOpen"
  | "shareDialogOpen"
  | "setShareDialogOpen"
  | "recordPanelOpen"
  | "setRecordPanelOpen"
  | "tightenApplyScope"
  | "setTightenApplyScope"
  | "hostMcpDialogOpen"
  | "setHostMcpDialogOpen"
  | "helpDialogOpen"
  | "setHelpDialogOpen"
  | "openJoinId"
  | "setOpenJoinId"
  | "joinMutationInFlight"
  | "setJoinMutationInFlight"
  | "fitToWindow"
  | "measureTimelineViewport"
>;

export const createUiSlice: StateCreator<DawStore, [], [], UiSlice> = (
  set,
  get,
) => {
  const lanePref = readLaneHeightPref();
  return {
    highlightStaleRender: false,
    renderPreviewBusy: false,
    ingestBusy: false,
    ingestDropTrackId: null as string | null,
    statusAnnouncement: "",
    pendingJobResults: {},
    setHighlightStaleRender: (highlightStaleRender) =>
      set({ highlightStaleRender }),
    setRenderPreviewBusy: (renderPreviewBusy) => set({ renderPreviewBusy }),
    setIngestBusy: (ingestBusy) => set({ ingestBusy }),
    setIngestDropTrackId: (ingestDropTrackId) => set({ ingestDropTrackId }),
    announceStatus: (statusAnnouncement) => set({ statusAnnouncement }),
    expectJobResult: (jobId) =>
      set((s) => ({
        pendingJobResults: { ...s.pendingJobResults, [jobId]: null },
      })),
    announceJobResult: (jobId, message) =>
      set((s) => ({
        pendingJobResults: { ...s.pendingJobResults, [jobId]: message },
      })),
    settleJobResult: (jobId) =>
      set((s) =>
        jobId in s.pendingJobResults
          ? {
              pendingJobResults: Object.fromEntries(
                Object.entries(s.pendingJobResults).filter(
                  ([id]) => id !== jobId,
                ),
              ),
            }
          : {},
      ),

    zoomPxPerSec: 40,
    waveformAmpZoom: 1,
    waveformScale: DEFAULT_WAVEFORM_VIEW_PREF.scale,
    waveformPostFader: DEFAULT_WAVEFORM_VIEW_PREF.postFader,
    pointerTrackId: null as string | null,
    setPointerTrackId: (pointerTrackId) => set({ pointerTrackId }),
    bladeHoverSec: null as number | null,
    setBladeHoverSec: (bladeHoverSec) => {
      if (bladeHoverSec !== get().bladeHoverSec) {
        set({ bladeHoverSec });
      }
    },
    scrollLeft: 0,
    // The desktop estimate (shellBreakpoint starts at desktop) until the
    // timeline measures, so first-render readers never see 0.
    timelineViewportWidth: estimateTimelineViewportWidth("desktop"),
    setTimelineViewportWidth: (px) => {
      // A hidden or zero-width scrollport measures 0: keep the shell estimate.
      const timelineViewportWidth =
        px > 0 ? px : estimateTimelineViewportWidth(get().shellBreakpoint);
      if (timelineViewportWidth !== get().timelineViewportWidth) {
        set({ timelineViewportWidth });
      }
    },
    resetTimelineViewportWidth: () =>
      get().setTimelineViewportWidth(
        estimateTimelineViewportWidth(get().shellBreakpoint),
      ),
    selection: null as Selection,
    activeTab: "transcript" as DawTab,
    userZoomed: false,
    layers: {
      showEdits: true,
      showLevels: true,
      showMarkers: true,
      showComments: true,
      showSilence: true,
      showSnapPoints: true,
      showProsody: false,
    } satisfies LayerVisibility,
    commentMode: false,
    commentDraft: null as CommentDraft | null,
    transcriptFollowPlayhead: true,
    transcriptInlineCommitPending: false,
    transcriptInlineEditFailure: null as TranscriptInlineEditFailure | null,
    transcriptReviewCursor: null as TranscriptReviewCursor | null,
    chapterAddPending: false,
    transcriptAnnotate: false,
    showCutAwayUtterances: false,
    timelineFocused: true,
    toolMode: "select" as ToolMode,
    selectedTrackIds: [] as string[],
    selectedClipIds: [] as string[],
    bladeConfirmSec: null as number | null,
    shellBreakpoint: "desktop" as ShellBreakpoint,
    // Capability baseline; usePointerType() corrects this from matchMedia
    // before first paint and keeps it live from pointer events.
    pointerKind: "fine" as PointerKind,
    mobileMode: "listen" as MobileMode,
    moreDestination: "hub" as MoreDestination,
    layoutMode: "default" as LayoutMode,
    laneHeightMode: lanePref.mode,
    laneHeightPx: lanePref.px,
    drawnLaneHeightPx: null as number | null,
    sheetExpanded: false,
    setZoomPxPerSec: (zoomPxPerSec) =>
      set({
        zoomPxPerSec: clampZoomPxPerSec(zoomPxPerSec, sessionSecOf(get())),
      }),
    setWaveformAmpZoom: (waveformAmpZoom) => {
      set({ waveformAmpZoom: clampWaveformAmp(waveformAmpZoom) });
      persistWaveformView(get());
    },
    nudgeWaveformAmp: (direction) => {
      const cur = get().waveformAmpZoom;
      const next =
        direction === "in"
          ? cur * discreteZoomFactor("in")
          : cur * discreteZoomFactor("out");
      set({
        waveformAmpZoom: clampWaveformAmp(
          Math.min(MAX_WAVEFORM_AMP, Math.max(MIN_WAVEFORM_AMP, next)),
        ),
      });
      persistWaveformView(get());
    },
    setWaveformScale: (waveformScale) => {
      set({ waveformScale });
      persistWaveformView(get());
    },
    setWaveformPostFader: (waveformPostFader) => {
      set({ waveformPostFader });
      persistWaveformView(get());
    },
    setScrollLeft: (scrollLeft) => set({ scrollLeft }),
    setSelection: (selection) =>
      set((s) => {
        if (selection == null || selection.kind !== "clip") {
          return { selection, selectedClipIds: [] };
        }
        if (s.selectedClipIds.includes(selection.id)) {
          return { selection };
        }
        return { selection, selectedClipIds: [selection.id] };
      }),
    selectClip: (clipId, trackId, mods) =>
      set((s) => {
        const shift = Boolean(mods?.shift);
        const mod = Boolean(mods?.mod);
        const has = s.selectedClipIds.includes(clipId);
        const asClip = {
          kind: "clip" as const,
          id: clipId,
          trackId,
        };
        if (shift) {
          const selectedClipIds = has
            ? s.selectedClipIds
            : [...s.selectedClipIds, clipId];
          return { selectedClipIds, selection: asClip };
        }
        if (mod) {
          const selectedClipIds = has
            ? s.selectedClipIds.filter((id) => id !== clipId)
            : [...s.selectedClipIds, clipId];
          if (selectedClipIds.length === 0) {
            return { selectedClipIds, selection: null };
          }
          if (
            has &&
            s.selection?.kind === "clip" &&
            s.selection.id === clipId
          ) {
            const nextId = selectedClipIds[selectedClipIds.length - 1]!;
            const nextTrack =
              nextId === clipId
                ? trackId
                : (clipTrackId(s.project, nextId) ?? trackId);
            return {
              selectedClipIds,
              selection: { kind: "clip", id: nextId, trackId: nextTrack },
            };
          }
          return {
            selectedClipIds,
            selection: has ? s.selection : asClip,
          };
        }
        return { selectedClipIds: [clipId], selection: asClip };
      }),
    setActiveTab: (activeTab) => set((s) => revealTab(s, activeTab)),
    setTranscriptFollowPlayhead: (transcriptFollowPlayhead) =>
      set({ transcriptFollowPlayhead }),
    toggleTranscriptFollowPlayhead: () =>
      set((s) => ({ transcriptFollowPlayhead: !s.transcriptFollowPlayhead })),
    setTranscriptInlineCommitPending: (transcriptInlineCommitPending) =>
      set({ transcriptInlineCommitPending }),
    setTranscriptInlineEditFailure: (transcriptInlineEditFailure) =>
      set({ transcriptInlineEditFailure }),
    setTranscriptReviewCursor: (transcriptReviewCursor) =>
      set({ transcriptReviewCursor }),
    setChapterAddPending: (chapterAddPending) => set({ chapterAddPending }),
    setTranscriptAnnotate: (transcriptAnnotate) => {
      set({
        transcriptAnnotate,
        ...(transcriptAnnotate ? {} : { showCutAwayUtterances: false }),
      });
    },
    toggleTranscriptAnnotate: () => {
      const next = !get().transcriptAnnotate;
      get().setTranscriptAnnotate(next);
    },
    setShowCutAwayUtterances: (showCutAwayUtterances) =>
      set({ showCutAwayUtterances }),
    toggleShowCutAwayUtterances: () =>
      set((s) => ({ showCutAwayUtterances: !s.showCutAwayUtterances })),
    setTimelineFocused: (timelineFocused) => set({ timelineFocused }),
    markUserZoomed: () => set({ userZoomed: true }),
    applyAnchoredZoom: (nextZoom, clientX) => {
      if (get().followingClientId) {
        get().stopFollow("local");
      }
      const el = timelineViewportRegistry.getTimelineElement();
      const currentZoom = get().zoomPxPerSec;
      const sessionSec = sessionSecOf(get());
      const z = clampZoomPxPerSec(nextZoom, sessionSec);
      if (!el) {
        set({ zoomPxPerSec: z, userZoomed: true });
        return;
      }
      const rect = el.getBoundingClientRect();
      const { headerOffsetPx: headerW, timeViewportPx: timeWidth } =
        measureTimelineColumns(el);
      // Sticky headers sit in the scrollport; time origin is to their right.
      const rectLeft = rect.left + headerW;
      if (clientX != null) {
        noteZoomPointerClientX(clientX);
      }
      const lead = timelineViewportRegistry.getLeadPx();
      if (lead > 0 && clientX == null) {
        // Command zoom (menu, keys) on a fixed playhead centers on the
        // playhead's time, not the line's pixel: the line may trail the
        // playhead by up to a pixel, and zooming in would grow that gap.
        const endSec = get().project?.timeline_duration_sec ?? 0;
        const scrollLeft = Math.min(
          centerSecToScrollLeft(endSec, z, timeWidth),
          Math.max(
            minLogicalScrollLeft(lead),
            centerSecToScrollLeft(get().playheadSec, z, timeWidth),
          ),
        );
        set({ zoomPxPerSec: z, scrollLeft, userZoomed: true });
        return;
      }
      const center = rectLeft + viewportCenterOffsetPx(timeWidth);
      // Command zoom keeps a visible playhead still (#533); pointer, then center.
      const playheadX =
        clientX == null
          ? visiblePlayheadClientX({
              playheadSec: get().playheadSec,
              zoomPxPerSec: currentZoom,
              scrollLeft: get().scrollLeft,
              rectLeft,
              viewportWidthPx: timeWidth,
            })
          : null;
      const anchorX =
        clientX ?? playheadX ?? peekZoomPointerClientX() ?? center;
      // Use store scroll/zoom so rapid pinch ticks do not re-anchor from a stale
      // DOM scrollLeft before useLayoutEffect applies the pending value.
      const { zoom, scrollLeft } = anchoredZoomScroll({
        currentZoom,
        nextZoom: z,
        clientX: anchorX,
        rectLeft,
        scrollLeft: get().scrollLeft,
        sessionSec,
        minScrollLeft: minLogicalScrollLeft(lead),
        // A padded view's range ends with the session end under the line.
        maxScrollLeft:
          lead > 0
            ? centerSecToScrollLeft(
                get().project?.timeline_duration_sec ?? 0,
                z,
                timeWidth,
              )
            : undefined,
      });
      // Store first; TimelineView applies el.scrollLeft in useLayoutEffect after
      // the wider (duration * zoom) content commits — avoids browser clamp.
      set({
        zoomPxPerSec: zoom,
        scrollLeft,
        userZoomed: true,
      });
    },
    setLayerVisible: (key, visible) =>
      set((s) => ({ layers: { ...s.layers, [key]: visible } })),
    setCommentMode: (commentMode) =>
      set({
        commentMode,
        commentDraft: commentMode ? get().commentDraft : null,
        ...(commentMode
          ? { toolMode: "select" as ToolMode, bladeConfirmSec: null }
          : {}),
      }),
    toggleCommentMode: () =>
      set((s) => {
        const next = !s.commentMode;
        return {
          commentMode: next,
          commentDraft: next ? s.commentDraft : null,
          ...(next ? revealTab(s, "comments") : {}),
          mobileMode: next ? "listen" : s.mobileMode,
          moreDestination: next ? "comments" : s.moreDestination,
          ...(next
            ? { toolMode: "select" as ToolMode, bladeConfirmSec: null }
            : {}),
        };
      }),
    setCommentDraft: (commentDraft) => set({ commentDraft }),
    setToolMode: (toolMode: ToolMode) =>
      set({
        toolMode,
        bladeConfirmSec: toolMode === "blade" ? get().bladeConfirmSec : null,
        commentMode: false,
        commentDraft: null,
      }),
    setSelectedTrackIds: (selectedTrackIds: string[]) =>
      set({ selectedTrackIds }),
    toggleTrackSelected: (trackId: string, additive: boolean) =>
      set((s) => {
        if (!additive) {
          return { selectedTrackIds: [trackId] };
        }
        const has = s.selectedTrackIds.includes(trackId);
        return {
          selectedTrackIds: has
            ? s.selectedTrackIds.filter((id) => id !== trackId)
            : [...s.selectedTrackIds, trackId],
        };
      }),
    setBladeConfirmSec: (bladeConfirmSec: number | null) =>
      set({ bladeConfirmSec }),
    setShellBreakpoint: (shellBreakpoint) => {
      set({
        shellBreakpoint,
        // The phone shell has no layouts: never carry one into it or back out.
        ...(shellBreakpoint === "phone"
          ? { layoutMode: "default" as LayoutMode }
          : {}),
      });
      // Re-derive from the live timeline: a registered scrollport that measures
      // 0 (a remount mid shell switch) and no timeline at all both store the
      // new shell's estimate, never the previous shell's.
      get().setTimelineViewportWidth(get().measureTimelineViewport());
    },
    setPointerKind: (pointerKind) =>
      set((s) => (s.pointerKind === pointerKind ? s : { pointerKind })),
    setMobileMode: (mobileMode) =>
      set({
        mobileMode,
        moreDestination: mobileMode === "more" ? get().moreDestination : "hub",
        ...(mobileMode === "text"
          ? { activeTab: "transcript" as DawTab, timelineFocused: false }
          : {}),
        ...(mobileMode === "timeline" ? { timelineFocused: true } : {}),
        ...(mobileMode === "listen" ? { timelineFocused: true } : {}),
      }),
    setMoreDestination: (moreDestination) =>
      set({
        moreDestination,
        mobileMode: "more",
        ...(moreDestination === "comments"
          ? { activeTab: "comments" as DawTab }
          : moreDestination === "history"
            ? { activeTab: "history" as DawTab }
            : moreDestination === "impact"
              ? { activeTab: "impact" as DawTab }
              : moreDestination === "tighten"
                ? { activeTab: "tighten" as DawTab }
                : moreDestination === "pipeline"
                  ? { activeTab: "pipeline" as DawTab }
                  : {}),
      }),
    setLayoutMode: (layoutMode) => {
      const tab = LAYOUT_TAB[layoutMode];
      set({
        layoutMode,
        ...(tab
          ? { activeTab: tab, timelineFocused: false }
          : layoutMode === "timeline"
            ? { timelineFocused: true }
            : {}),
      });
    },
    setSheetExpanded: (sheetExpanded) => set({ sheetExpanded }),
    setLaneHeightMode: (laneHeightMode: LaneHeightMode) => {
      set({ laneHeightMode });
      writeLaneHeightPref({ mode: laneHeightMode, px: get().laneHeightPx });
    },
    toggleFitTracksHeight: () =>
      get().setLaneHeightMode(get().laneHeightMode === "fit" ? "fixed" : "fit"),
    stepLaneHeight: (direction: "up" | "down") => {
      // From fit mode, step from the height the lanes are drawn at, so
      // Increase never shrinks them and Decrease never grows them.
      const { laneHeightMode, laneHeightPx: saved, drawnLaneHeightPx } = get();
      const from =
        laneHeightMode === "fit" && drawnLaneHeightPx != null
          ? drawnLaneHeightPx
          : saved;
      const laneHeightPx = stepLaneHeightPx(from, direction);
      set({ laneHeightMode: "fixed", laneHeightPx });
      writeLaneHeightPref({ mode: "fixed", px: laneHeightPx });
    },
    setDrawnLaneHeightPx: (drawnLaneHeightPx) => {
      if (get().drawnLaneHeightPx !== drawnLaneHeightPx) {
        set({ drawnLaneHeightPx });
      }
    },
    commandPaletteOpen: false,
    setCommandPaletteOpen: (commandPaletteOpen) =>
      set({
        commandPaletteOpen,
        ...(commandPaletteOpen ? { gesturesSheetOpen: false } : {}),
      }),
    gesturesSheetOpen: false,
    setGesturesSheetOpen: (gesturesSheetOpen) =>
      set({
        gesturesSheetOpen,
        ...(gesturesSheetOpen ? { commandPaletteOpen: false } : {}),
      }),
    toggleCommandPalette: () =>
      set((s) => ({
        commandPaletteOpen: !s.commandPaletteOpen,
        ...(!s.commandPaletteOpen ? { gesturesSheetOpen: false } : {}),
      })),
    bounceDialogOpen: false,
    setBounceDialogOpen: (bounceDialogOpen) => set({ bounceDialogOpen }),
    shareDialogOpen: false,
    setShareDialogOpen: (shareDialogOpen) => set({ shareDialogOpen }),
    recordPanelOpen: false,
    setRecordPanelOpen: (recordPanelOpen) => set({ recordPanelOpen }),
    tightenApplyScope: { avoidHarsh: true, ids: [] },
    setTightenApplyScope: (tightenApplyScope) => set({ tightenApplyScope }),
    hostMcpDialogOpen: false,
    setHostMcpDialogOpen: (hostMcpDialogOpen) => set({ hostMcpDialogOpen }),
    helpDialogOpen: false,
    setHelpDialogOpen: (helpDialogOpen) => set({ helpDialogOpen }),
    openJoinId: null,
    setOpenJoinId: (openJoinId) => set({ openJoinId }),
    joinMutationInFlight: false,
    setJoinMutationInFlight: (joinMutationInFlight) =>
      set({ joinMutationInFlight }),
    fitToWindow: (viewportWidth) => {
      const duration = sessionSecOf(get());
      if (duration > 0 && viewportWidth > 0) {
        const zoom = fitZoomPxPerSec(viewportWidth, duration);
        // A fixed playhead stays on the line through a fit.
        const scrollLeft =
          timelineViewportRegistry.getLeadPx() > 0
            ? centerSecToScrollLeft(get().playheadSec, zoom, viewportWidth)
            : 0;
        set({ zoomPxPerSec: zoom, scrollLeft, userZoomed: false });
      }
    },
    measureTimelineViewport: () => {
      const el = timelineViewportRegistry.getTimelineElement();
      return el
        ? timelineTimeViewportWidth(el)
        : estimateTimelineViewportWidth(get().shellBreakpoint);
    },
  };
};
