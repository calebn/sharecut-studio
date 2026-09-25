import type { PipelineJobSnapshot } from "../types/pipeline";
import type { ProjectView, Selection } from "../types/project";
import type {
  AuditionMode,
  PresenceMobileMode,
  PresenceTab,
  SessionClient,
  SessionRegion,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";

export type { AuditionMode } from "../types/session";

export interface LayerVisibility {
  showEdits: boolean;
  showLevels: boolean;
  showMarkers: boolean;
  showComments: boolean;
}

export type DawTab = PresenceTab;

/** Phone bottom-nav mode (Listen / Timeline / Text / More). */
export type MobileMode = PresenceMobileMode;

/** Timeline tool — select inspects; blade splits at click/playhead. */
export type ToolMode = "select" | "blade";

/** Desktop/tablet chrome focus — see docs/gui-mobile.md. */
export type FocusMode = "default" | "timeline" | "text" | "review";

export type ShellBreakpoint = "phone" | "tablet" | "desktop";

/**
 * Last-used pointing device kind: fine (mouse/pen) vs coarse (touch).
 * Tracked live from Pointer Events; drives input-mode adaptation (e.g. the
 * presence `mobile_mode` payload), never presence visibility.
 */
export type PointerKind = "fine" | "coarse";

export type MoreDestination =
  | "hub"
  | "comments"
  | "history"
  | "impact"
  | "tighten"
  | "pipeline";

export interface CommentDraft {
  startSec: number;
  endSec: number | null;
}

export type PlaySkipRange = { start: number; end: number };

/** After Current playUntil, pause then play Suggested with this skip. */
export type PlayAbFollowup = {
  start: number;
  until: number;
  skipStart: number;
  skipEnd: number;
  gapSec: number;
};

/** Public DAW API — same shape as the former Context value. */
export interface DawState {
  project: ProjectView | null;
  projectPath: string;
  /** Changes when the viewer opens a different project, even if it later returns. */
  projectEpoch: number;
  /** Share guest mode from bootstrap; null for host. */
  guestMode: string | null;
  /** Share capability list from bootstrap; null for host. */
  shareCapabilities: string[] | null;
  playheadSec: number;
  zoomPxPerSec: number;
  waveformAmpZoom: number;
  pointerTrackId: string | null;
  /** Blade-mode pointer time (s) over the lanes; null when not hovering. */
  bladeHoverSec: number | null;
  scrollLeft: number;
  /** Visible time column (px) of the mounted timeline, from its observer; the shell estimate before it measures and after it unmounts. */
  timelineViewportWidth: number;
  selection: Selection;
  activeTab: DawTab;
  userZoomed: boolean;
  layers: LayerVisibility;
  commentMode: boolean;
  commentDraft: CommentDraft | null;
  transcriptFollowPlayhead: boolean;
  transcriptAnnotate: boolean;
  showCutAwayUtterances: boolean;
  pipelineJob: PipelineJobSnapshot | null;
  /** Most recent Studio activity (pipeline or agent) for StatusBar chrome. */
  activityJob: PipelineJobSnapshot | null;
  activityRunningCount: number;
  isPlaying: boolean;
  auditionMode: AuditionMode;
  viewerMute: Record<string, boolean>;
  soloTracks: Record<string, boolean>;
  timelineFocused: boolean;
  toolMode: ToolMode;
  selectedTrackIds: string[];
  /** Multi-clip body selection (inspector still uses `selection` as primary). */
  selectedClipIds: string[];
  /** Phone: pending blade cut time awaiting confirm sheet. */
  bladeConfirmSec: number | null;
  audioError: string | null;
  sessionRegion: SessionRegion | null;
  lastAgentQuery: string | null;
  playUntilSec: number | null;
  playSkipStartSec: number | null;
  playSkipEndSec: number | null;
  playAbFollowup: PlayAbFollowup | null;
  auditionEpoch: number;
  lastAppliedRevision: number;
  lastAppliedCommandId: string | null;
  suppressPublish: boolean;
  shellBreakpoint: ShellBreakpoint;
  pointerKind: PointerKind;
  mobileMode: MobileMode;
  moreDestination: MoreDestination;
  focusMode: FocusMode;
  sheetExpanded: boolean;
  /** Command cheatsheet / palette open. */
  commandPaletteOpen: boolean;
  /** Mobile gestures cheatsheet open. */
  gesturesSheetOpen: boolean;
  /** Bounce dialog open (host export/bounces). */
  bounceDialogOpen: boolean;
  /** Host share management dialog. */
  shareDialogOpen: boolean;
  /** Host record-room control panel. */
  recordPanelOpen: boolean;
  /** Tighten tab Apply-eligible scope for keyboard shortcuts. */
  tightenApplyScope: { avoidHarsh: boolean; ids: string[] };
  setTightenApplyScope: (scope: { avoidHarsh: boolean; ids: string[] }) => void;
  /** Local host MCP connect dialog (Streamable HTTP URL). */
  hostMcpDialogOpen: boolean;
  /** Host Help → diagnostics bundle dialog. */
  helpDialogOpen: boolean;
  /** Hover/focus Stale pill → highlight stale lanes on the timeline. */
  highlightStaleRender: boolean;
  /** Refresh-mix / render_preview in flight. */
  renderPreviewBusy: boolean;
  /** Audio import / track ingest in flight. */
  ingestBusy: boolean;
  /** Track id highlighted while dragging audio over a lane (TCP sync). */
  ingestDropTrackId: string | null;
  /** Polite live-region status (refresh mix, etc.). */
  statusAnnouncement: string;
  /** Presence roster from session Snapshot / Presence events. */
  sessionClients: SessionClient[];
  setSessionClients: (clients: SessionClient[]) => void;
  serverClockOffsetMs: number;
  setServerClockOffsetMs: (ms: number) => void;
  localClientId: string | null;
  setLocalClientId: (id: string | null) => void;
  followingClientId: string | null;
  startFollow: (clientId: string) => void;
  stopFollow: (reason?: string) => void;
  followDegraded: { tab?: DawTab; audition?: "fx" | "raw" };
  setFollowDegraded: (d: DawState["followDegraded"]) => void;
  transcriptViewAnchor: string | null;
  setTranscriptViewAnchor: (id: string | null) => void;
  transcriptScrollRequest: string | null;
  setTranscriptScrollRequest: (id: string | null) => void;
  setViewerMuteMap: (map: Record<string, boolean>) => void;
  setSoloMap: (map: Record<string, boolean>) => void;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  setProject: (project: ProjectView) => void;
  setGuestMode: (mode: string | null) => void;
  setPlayheadSec: (sec: number) => void;
  /** Set zoom, clamped to the session-aware ceiling. */
  setZoomPxPerSec: (z: number) => void;
  /**
   * Re-clamp zoom after the session length changes (a shorter session has a
   * higher ceiling, a longer one a lower), keeping the viewport centre.
   */
  reclampZoomForDuration: () => void;
  setScrollLeft: (x: number) => void;
  setSelection: (sel: Selection) => void;
  selectClip: (
    clipId: string,
    trackId: string,
    mods?: { shift?: boolean; mod?: boolean },
  ) => void;
  setActiveTab: (tab: DawTab) => void;
  setTranscriptFollowPlayhead: (on: boolean) => void;
  toggleTranscriptFollowPlayhead: () => void;
  setTranscriptAnnotate: (on: boolean) => void;
  toggleTranscriptAnnotate: () => void;
  setShowCutAwayUtterances: (on: boolean) => void;
  toggleShowCutAwayUtterances: () => void;
  setPipelineJob: (job: PipelineJobSnapshot | null) => void;
  setActivityJob: (job: PipelineJobSnapshot | null) => void;
  setActivityRunningCount: (count: number) => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setAuditionMode: (mode: AuditionMode) => void;
  toggleViewerMute: (trackId: string) => void;
  toggleSolo: (trackId: string) => void;
  setTimelineFocused: (focused: boolean) => void;
  setAudioError: (msg: string | null) => void;
  applyAgentSession: (state: SessionState) => void;
  clearSessionRegion: () => void;
  setPlayUntilSec: (sec: number | null) => void;
  beginAudition: (opts: {
    playheadSec: number;
    untilSec: number;
    skip?: PlaySkipRange | null;
    abFollowup?: PlayAbFollowup | null;
  }) => void;
  /** Keep playing; swap skip/until (A/B followup). Does not remount transport. */
  continueAudition: (opts: {
    playheadSec: number;
    untilSec: number;
    skip?: PlaySkipRange | null;
  }) => void;
  buildViewerSnapshot: () => ViewerSessionSnapshot;
  markUserZoomed: () => void;
  /**
   * Clamp zoom and keep time under clientX stable. Falls back to the last
   * noted timeline pointer X (`noteZoomPointerClientX`), then viewport center.
   * On a fixed playhead (a lead is registered), command zoom with no clientX
   * centers on the playhead instead, and every zoom stays within the session.
   */
  applyAnchoredZoom: (nextZoom: number, clientX?: number) => void;
  setWaveformAmpZoom: (amp: number) => void;
  nudgeWaveformAmp: (direction: "in" | "out") => void;
  setPointerTrackId: (trackId: string | null) => void;
  setBladeHoverSec: (sec: number | null) => void;
  /** Stores a measured width; 0 or less stores the shell estimate instead. */
  setTimelineViewportWidth: (px: number) => void;
  /** Back to the current shell's estimate (the timeline unmounted). */
  resetTimelineViewportWidth: () => void;
  setLayerVisible: (key: keyof LayerVisibility, visible: boolean) => void;
  setCommentMode: (on: boolean) => void;
  toggleCommentMode: () => void;
  setCommentDraft: (draft: CommentDraft | null) => void;
  setToolMode: (mode: ToolMode) => void;
  setSelectedTrackIds: (ids: string[]) => void;
  toggleTrackSelected: (trackId: string, additive: boolean) => void;
  setBladeConfirmSec: (sec: number | null) => void;
  fitToWindow: (viewportWidth: number) => void;
  registerTimelineViewport: (el: HTMLElement | null) => void;
  /** Fixed-playhead lead pad (px) of the mounted timeline; 0 when unpadded. */
  registerTimelineLead: (px: number) => void;
  _lanesEl: HTMLElement | null;
  registerLanesEl: (el: HTMLElement | null) => void;
  measureTimelineViewport: () => number;
  /** Also re-stores `timelineViewportWidth` from the live timeline or the new shell's estimate. */
  setShellBreakpoint: (bp: ShellBreakpoint) => void;
  setPointerKind: (kind: PointerKind) => void;
  setMobileMode: (mode: MobileMode) => void;
  setMoreDestination: (dest: MoreDestination) => void;
  setFocusMode: (mode: FocusMode) => void;
  cycleFocusMode: () => void;
  setSheetExpanded: (on: boolean) => void;
  setCommandPaletteOpen: (on: boolean) => void;
  setGesturesSheetOpen: (on: boolean) => void;
  toggleCommandPalette: () => void;
  setBounceDialogOpen: (on: boolean) => void;
  setShareDialogOpen: (on: boolean) => void;
  setRecordPanelOpen: (on: boolean) => void;
  setHostMcpDialogOpen: (on: boolean) => void;
  setHelpDialogOpen: (on: boolean) => void;
  setHighlightStaleRender: (on: boolean) => void;
  setRenderPreviewBusy: (on: boolean) => void;
  setIngestBusy: (on: boolean) => void;
  setIngestDropTrackId: (trackId: string | null) => void;
  announceStatus: (message: string) => void;
}
