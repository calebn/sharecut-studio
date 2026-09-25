import { create } from "zustand";
import {
  abortStaleWaveformWork,
  getWaveformTileLru,
  noteWaveformScrollDir,
} from "../audio/waveformScheduler";
import { clearWavHeaderCache } from "../audio/waveformSource";
import { cssViewportWidth } from "../hooks/useViewportClass";
import { selectionFromWire, selectionToWire } from "../session/wire";
import { guestHearsMixOnly } from "../shareMode";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { ProjectView, Selection } from "../types/project";
import type {
  AuditionMode,
  SessionClient,
  SessionRegion,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";
import {
  centerSecToScrollLeft,
  measureTimelineColumns,
  minLogicalScrollLeft,
  timelineTimeViewportWidth,
  viewportCenterOffsetPx,
} from "../utils/timelineViewport";
import {
  anchoredZoomScroll,
  clampWaveformAmp,
  clampZoomPxPerSec,
  discreteZoomFactor,
  fitZoomPxPerSec,
  MAX_WAVEFORM_AMP,
  MIN_WAVEFORM_AMP,
} from "../utils/zoom";
import {
  noteZoomPointerClientX,
  peekZoomPointerClientX,
} from "../utils/zoomPointer";
import type {
  CommentDraft,
  DawState,
  DawTab,
  FocusMode,
  LayerVisibility,
  MobileMode,
  MoreDestination,
  PlayAbFollowup,
  PointerKind,
  ShellBreakpoint,
  ToolMode,
} from "./types";

const FOCUS_CYCLE: FocusMode[] = ["default", "timeline", "text", "review"];

function clipTrackId(
  project: ProjectView | null,
  clipId: string,
): string | null {
  if (!project) {
    return null;
  }
  for (const [trackId, list] of Object.entries(project.clips.tracks)) {
    if (list.some((c) => c.id === clipId)) {
      return trackId;
    }
  }
  return null;
}

type DawStore = DawState & {
  _timelineEl: HTMLElement | null;
  /** Fixed-playhead lead pad; logical scroll may go down to −lead. */
  _timelineLeadPx: number;
  _lanesEl: HTMLElement | null;
  _suppressTimer: number | null;
  hydrate: (
    projectPath: string,
    initialProject: ProjectView | null,
    guestMode?: string | null,
    shareCapabilities?: string[] | null,
  ) => void;
};

/** Time-column width guess (px) for a shell whose timeline has not measured. */
export function estimateTimelineViewportWidth(bp: ShellBreakpoint): number {
  const w = cssViewportWidth();
  if (bp === "phone") {
    return Math.max(200, w);
  }
  if (bp === "tablet") {
    return Math.max(200, w - 200);
  }
  return Math.max(200, w - 500);
}

export const useDawStore = create<DawStore>((set, get) => ({
  // --- project ---
  project: null,
  projectPath: "",
  projectEpoch: 0,
  guestMode: null as string | null,
  shareCapabilities: null as string[] | null,
  sessionClients: [] as SessionClient[],
  setSessionClients: (sessionClients) => set({ sessionClients }),
  serverClockOffsetMs: 0,
  setServerClockOffsetMs: (serverClockOffsetMs) => set({ serverClockOffsetMs }),
  localClientId: null as string | null,
  setLocalClientId: (localClientId) => set({ localClientId }),
  followingClientId: null as string | null,
  followDegraded: {} as DawState["followDegraded"],
  setFollowDegraded: (followDegraded) => set({ followDegraded }),
  transcriptViewAnchor: null as string | null,
  setTranscriptViewAnchor: (transcriptViewAnchor) =>
    set({ transcriptViewAnchor }),
  transcriptScrollRequest: null as string | null,
  setTranscriptScrollRequest: (transcriptScrollRequest) =>
    set({ transcriptScrollRequest }),
  playbackRate: 1,
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  startFollow: (clientId) => {
    const s = get();
    const target = s.sessionClients.find((c) => c.client_id === clientId);
    const name = target?.meta?.display_name || target?.label || clientId;
    set({ followingClientId: clientId });
    get().announceStatus(`Following ${name}`);
  },
  stopFollow: (reason) => {
    if (get().followingClientId == null) {
      return;
    }
    set({ followingClientId: null, playbackRate: 1, followDegraded: {} });
    if (reason === "left") {
      get().announceStatus("They left");
    } else {
      get().announceStatus("Stopped following");
    }
  },
  setProject: (project) => set({ project }),
  setGuestMode: (guestMode: string | null) => set({ guestMode }),
  setPipelineJob: (pipelineJob: PipelineJobSnapshot | null) =>
    set({ pipelineJob }),
  pipelineJob: null,
  setActivityJob: (activityJob: PipelineJobSnapshot | null) =>
    set({ activityJob }),
  activityJob: null,
  setActivityRunningCount: (activityRunningCount: number) =>
    set({ activityRunningCount }),
  activityRunningCount: 0,
  highlightStaleRender: false,
  renderPreviewBusy: false,
  ingestBusy: false,
  ingestDropTrackId: null as string | null,
  statusAnnouncement: "",
  setHighlightStaleRender: (highlightStaleRender) =>
    set({ highlightStaleRender }),
  setRenderPreviewBusy: (renderPreviewBusy) => set({ renderPreviewBusy }),
  setIngestBusy: (ingestBusy) => set({ ingestBusy }),
  setIngestDropTrackId: (ingestDropTrackId) => set({ ingestDropTrackId }),
  announceStatus: (statusAnnouncement) => set({ statusAnnouncement }),

  // --- transport ---
  playheadSec: 0,
  isPlaying: false,
  auditionMode: "mix" as AuditionMode,
  viewerMute: {},
  soloTracks: {},
  sessionRegion: null as SessionRegion | null,
  lastAgentQuery: null as string | null,
  playUntilSec: null as number | null,
  playSkipStartSec: null as number | null,
  playSkipEndSec: null as number | null,
  playAbFollowup: null as PlayAbFollowup | null,
  auditionEpoch: 0,
  audioError: null as string | null,
  setPlayheadSec: (playheadSec) => set({ playheadSec }),
  setIsPlaying: (isPlaying) =>
    set((s) => ({
      isPlaying,
      // Local transport owns the clock — clear agent audition auto-stop.
      playUntilSec: isPlaying ? null : s.playUntilSec,
      playSkipStartSec: isPlaying ? null : s.playSkipStartSec,
      playSkipEndSec: isPlaying ? null : s.playSkipEndSec,
      playAbFollowup: isPlaying ? null : s.playAbFollowup,
    })),
  togglePlaying: () =>
    set((s) => {
      const next = !s.isPlaying;
      return {
        isPlaying: next,
        playUntilSec: next ? null : s.playUntilSec,
        playSkipStartSec: next ? null : s.playSkipStartSec,
        playSkipEndSec: next ? null : s.playSkipEndSec,
        playAbFollowup: next ? null : s.playAbFollowup,
      };
    }),
  setAuditionMode: (auditionMode) =>
    set((s) => ({
      auditionMode: guestHearsMixOnly(s.guestMode) ? "mix" : auditionMode,
    })),
  setViewerMuteMap: (viewerMute) => set({ viewerMute }),
  setSoloMap: (soloTracks) => set({ soloTracks }),
  toggleViewerMute: (trackId) =>
    set((s) => ({
      viewerMute: { ...s.viewerMute, [trackId]: !s.viewerMute[trackId] },
    })),
  toggleSolo: (trackId) =>
    set((s) => ({
      soloTracks: { ...s.soloTracks, [trackId]: !s.soloTracks[trackId] },
    })),
  setPlayUntilSec: (playUntilSec) => set({ playUntilSec }),
  beginAudition: ({ playheadSec, untilSec, skip, abFollowup }) =>
    set((s) => ({
      playheadSec,
      isPlaying: true,
      playUntilSec: untilSec,
      playSkipStartSec: skip?.start ?? null,
      playSkipEndSec: skip?.end ?? null,
      playAbFollowup: abFollowup ?? null,
      auditionEpoch: s.auditionEpoch + 1,
    })),
  continueAudition: ({ playheadSec, untilSec, skip }) =>
    set({
      playheadSec,
      isPlaying: true,
      playUntilSec: untilSec,
      playSkipStartSec: skip?.start ?? null,
      playSkipEndSec: skip?.end ?? null,
      playAbFollowup: null,
    }),
  setAudioError: (audioError) => set({ audioError }),
  clearSessionRegion: () =>
    set({
      sessionRegion: null,
      playUntilSec: null,
      playSkipStartSec: null,
      playSkipEndSec: null,
      playAbFollowup: null,
      lastAgentQuery: null,
    }),

  // --- session publish ---
  lastAppliedRevision: 0,
  lastAppliedCommandId: null as string | null,
  suppressPublish: false,
  _suppressTimer: null,
  applyAgentSession: (state: SessionState) => {
    const prev = get()._suppressTimer;
    if (prev != null) {
      window.clearTimeout(prev);
    }
    const timer = window.setTimeout(() => {
      set({ suppressPublish: false, _suppressTimer: null });
    }, 1200);
    const fromAgent = (state.last_role ?? state.origin) === "agent";
    const guestHear = guestHearsMixOnly(get().guestMode);
    const hear = guestHear
      ? { auditionMode: "mix" as const }
      : {
          auditionMode: state.audition_mode,
          viewerMute: state.viewer_mute ?? {},
          soloTracks: state.solo_tracks ?? {},
        };
    // Only agents may remotely drive transport. Viewer echoes/polls update
    // selection-ish fields without stomping local play/pause or auto-stop.
    // Guests hear Mix only — never copy host audition / mute / solo maps.
    if (fromAgent) {
      const nextSel = selectionFromWire(
        state.selection,
        get().project?.envelopes,
      );
      set({
        suppressPublish: true,
        _suppressTimer: timer,
        lastAppliedRevision: state.server_seq,
        lastAppliedCommandId: state.last_command_id,
        playheadSec: state.playhead_sec,
        lastAgentQuery: state.query,
        sessionRegion: state.region,
        playUntilSec:
          state.region && state.is_playing ? state.region.end_sec : null,
        playSkipStartSec: null,
        playSkipEndSec: null,
        playAbFollowup: null,
        auditionEpoch: get().auditionEpoch + 1,
        isPlaying: Boolean(state.is_playing),
        ...hear,
        ...(state.selection !== undefined ? { selection: nextSel } : {}),
        ...(state.clients ? { sessionClients: state.clients } : {}),
      });
      return;
    }
    const nextSel = selectionFromWire(
      state.selection,
      get().project?.envelopes,
    );
    set({
      suppressPublish: true,
      _suppressTimer: timer,
      lastAppliedRevision: state.server_seq,
      lastAppliedCommandId: state.last_command_id,
      ...hear,
      ...(nextSel !== undefined && state.selection !== undefined
        ? { selection: nextSel }
        : {}),
      ...(state.clients ? { sessionClients: state.clients } : {}),
    });
  },
  buildViewerSnapshot: (): ViewerSessionSnapshot => {
    const s = get();
    const source =
      s.auditionMode === "mix"
        ? "premix"
        : s.auditionMode === "fx"
          ? "processed"
          : "track";
    const snap: ViewerSessionSnapshot = {
      audition_mode: s.auditionMode,
      region: s.sessionRegion,
      source,
      track_id: Object.keys(s.soloTracks).find((k) => s.soloTracks[k]) ?? null,
      query: s.lastAgentQuery,
      selection: selectionToWire(s.selection, s.project?.envelopes),
      viewer_mute: s.viewerMute,
      solo_tracks: s.soloTracks,
      ack_command_id: s.lastAppliedCommandId,
    };
    if (s.followingClientId == null) {
      snap.playhead_sec = s.playheadSec;
      snap.is_playing = s.isPlaying;
    }
    return snap;
  },

  // --- ui ---
  zoomPxPerSec: 40,
  waveformAmpZoom: 1,
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
  } satisfies LayerVisibility,
  commentMode: false,
  commentDraft: null as CommentDraft | null,
  transcriptFollowPlayhead: true,
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
  focusMode: "default" as FocusMode,
  sheetExpanded: false,
  _timelineEl: null,
  _timelineLeadPx: 0,
  _lanesEl: null,
  setZoomPxPerSec: (zoomPxPerSec) => {
    if (zoomPxPerSec !== get().zoomPxPerSec) {
      abortStaleWaveformWork();
    }
    set({ zoomPxPerSec });
  },
  setWaveformAmpZoom: (waveformAmpZoom) =>
    set({ waveformAmpZoom: clampWaveformAmp(waveformAmpZoom) }),
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
  },
  setScrollLeft: (scrollLeft) => {
    const prev = get().scrollLeft;
    if (scrollLeft > prev + 1) {
      noteWaveformScrollDir(1);
    } else if (scrollLeft < prev - 1) {
      noteWaveformScrollDir(-1);
    }
    set({ scrollLeft });
  },
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
        if (has && s.selection?.kind === "clip" && s.selection.id === clipId) {
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
  setActiveTab: (activeTab) => set({ activeTab }),
  setTranscriptFollowPlayhead: (transcriptFollowPlayhead) =>
    set({ transcriptFollowPlayhead }),
  toggleTranscriptFollowPlayhead: () =>
    set((s) => ({ transcriptFollowPlayhead: !s.transcriptFollowPlayhead })),
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
    const el = get()._timelineEl;
    const currentZoom = get().zoomPxPerSec;
    const z = clampZoomPxPerSec(nextZoom);
    if (z !== currentZoom) {
      abortStaleWaveformWork();
    }
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
    const lead = get()._timelineLeadPx;
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
    const anchorX = clientX ?? peekZoomPointerClientX() ?? center;
    // Use store scroll/zoom so rapid pinch ticks do not re-anchor from a stale
    // DOM scrollLeft before useLayoutEffect applies the pending value.
    const { zoom, scrollLeft } = anchoredZoomScroll({
      currentZoom,
      nextZoom: z,
      clientX: anchorX,
      rectLeft,
      scrollLeft: get().scrollLeft,
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
        activeTab: next ? "comments" : s.activeTab,
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
    set({ shellBreakpoint });
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
  setFocusMode: (focusMode) =>
    set({
      focusMode,
      ...(focusMode === "text"
        ? { activeTab: "transcript" as DawTab, timelineFocused: false }
        : focusMode === "review"
          ? { activeTab: "comments" as DawTab, timelineFocused: false }
          : focusMode === "timeline"
            ? { timelineFocused: true }
            : {}),
    }),
  cycleFocusMode: () =>
    set((s) => {
      const i = FOCUS_CYCLE.indexOf(s.focusMode);
      const next = FOCUS_CYCLE[(i + 1) % FOCUS_CYCLE.length] ?? "default";
      return {
        focusMode: next,
        ...(next === "text"
          ? { activeTab: "transcript" as DawTab, timelineFocused: false }
          : next === "review"
            ? { activeTab: "comments" as DawTab, timelineFocused: false }
            : next === "timeline"
              ? { timelineFocused: true }
              : {}),
      };
    }),
  setSheetExpanded: (sheetExpanded) => set({ sheetExpanded }),
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
  fitToWindow: (viewportWidth) => {
    const duration = get().project?.timeline_duration_sec ?? 60;
    if (duration > 0 && viewportWidth > 0) {
      abortStaleWaveformWork();
      const zoom = fitZoomPxPerSec(viewportWidth, duration);
      // A fixed playhead stays on the line through a fit.
      const scrollLeft =
        get()._timelineLeadPx > 0
          ? centerSecToScrollLeft(get().playheadSec, zoom, viewportWidth)
          : 0;
      set({ zoomPxPerSec: zoom, scrollLeft, userZoomed: false });
    }
  },
  registerTimelineViewport: (el) => set({ _timelineEl: el }),
  registerTimelineLead: (px) => set({ _timelineLeadPx: px }),
  registerLanesEl: (el) => set({ _lanesEl: el }),
  measureTimelineViewport: () => {
    const el = get()._timelineEl;
    return el
      ? timelineTimeViewportWidth(el)
      : estimateTimelineViewportWidth(get().shellBreakpoint);
  },

  hydrate: (
    projectPath,
    initialProject,
    guestMode = null,
    shareCapabilities = null,
  ) => {
    abortStaleWaveformWork();
    getWaveformTileLru().clear();
    clearWavHeaderCache();
    const samePath = get().projectPath === projectPath;
    set({
      projectPath,
      projectEpoch: samePath ? get().projectEpoch : get().projectEpoch + 1,
      project: initialProject,
      guestMode,
      shareCapabilities,
      sessionClients: samePath ? get().sessionClients : [],
      followingClientId: samePath ? get().followingClientId : null,
      localClientId: samePath ? get().localClientId : null,
      serverClockOffsetMs: samePath ? get().serverClockOffsetMs : 0,
      followDegraded: samePath ? get().followDegraded : {},
      transcriptScrollRequest: samePath ? get().transcriptScrollRequest : null,
      transcriptViewAnchor: samePath ? get().transcriptViewAnchor : null,
      playbackRate: samePath ? get().playbackRate : 1,
      ingestBusy: false,
      ingestDropTrackId: null,
      // Preserve transport on a same-project shell refresh. A project switch
      // starts a new session and discards the previous project's status (#78).
      ...(samePath
        ? {}
        : {
            audioError: null,
            isPlaying: false,
            playheadSec: 0,
            viewerMute: {},
            soloTracks: {},
            sessionRegion: null,
            lastAgentQuery: null,
            playUntilSec: null,
            playSkipStartSec: null,
            playSkipEndSec: null,
            playAbFollowup: null,
            auditionEpoch: 0,
            highlightStaleRender: false,
            renderPreviewBusy: false,
          }),
    });
  },
}));
