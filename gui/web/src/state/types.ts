import type { PresenceDeltaChanges, SessionRoster } from "../presence/roster";
import type { PendingJobResults, PipelineJobSnapshot } from "../types/pipeline";
import type {
  ProjectView,
  Selection,
  TranscriptWordBooleanFlag,
} from "../types/project";
import type {
  AuditionMode,
  PresenceMobileMode,
  PresenceTab,
  SessionClient,
  SessionRegion,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";
import type { LaneHeightMode } from "../utils/laneHeightPref";
import type { WaveformScaleMode } from "../waveform/types";

export type { AuditionMode } from "../types/session";
export type { LaneHeightMode } from "../utils/laneHeightPref";

export interface LayerVisibility {
  showEdits: boolean;
  showLevels: boolean;
  showMarkers: boolean;
  showComments: boolean;
  showSilence: boolean;
  showSnapPoints: boolean;
  /** Prosody overlay + transcript emphasis (host only, opt-in, #719). */
  showProsody: boolean;
}

/** A failed word action (inline fix, or WORD inspector Apply / Suppress / Ignore) whose editor had already closed. */
export interface TranscriptInlineEditFailure {
  /** Project the fix was submitted to; a failure from another project is dropped. */
  projectPath: string;
  trackId: string;
  wordIndex: number;
  /** Word text when the fix was submitted; different text means it was fixed since. */
  originalText: string;
  /** Failed Suppress / Ignore: that flag's value when the action was submitted; a different value means it was retried (or changed) since. Absent for a text fix. */
  flag?: { name: TranscriptWordBooleanFlag; was: boolean };
  message: string;
}

/** Low-confidence walkthrough position (#634). */
export interface TranscriptReviewCursor {
  trackId: string;
  wordIndex: number;
  /** `LowConfidenceStop.order` when visited: once this word leaves the list (corrected, maybe in a batch), the walk resumes at the nearest stop after / before it in transcript order. */
  order: number;
}

export type DawTab = PresenceTab;

/** Phone bottom-nav mode (Listen / Timeline / Text / More). */
export type MobileMode = PresenceMobileMode;

/** Timeline tool — select inspects; blade splits at click/playhead. */
export type ToolMode = "select" | "blade";

/** Desktop/tablet shell layout — see docs/gui-mobile.md § Desktop — layouts. */
export type LayoutMode = "default" | "timeline" | "text" | "review";

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
  /** Waveform scale: auto (dialogue in dB), linear or log; remembered per project. */
  waveformScale: WaveformScaleMode;
  /** Draw waveforms scaled by each track's output gain (gain_db + fader_db). */
  waveformPostFader: boolean;
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
  /** An inline transcript word fix is saving; outlives a TranscriptPanel remount (tab switch). */
  transcriptInlineCommitPending: boolean;
  /** Late failure of an inline word fix; outlives a TranscriptPanel remount. */
  transcriptInlineEditFailure: TranscriptInlineEditFailure | null;
  /** Current low-confidence walkthrough stop; outlives a TranscriptPanel remount, reset by a project switch (hydrate). */
  transcriptReviewCursor: TranscriptReviewCursor | null;
  /** `edit.addChapter` (Menu › Markers, MobileShell More) is in flight for the current project; outlives a menu remount, reset by a project switch (hydrate). */
  chapterAddPending: boolean;
  showCutAwayUtterances: boolean;
  pipelineJob: PipelineJobSnapshot | null;
  /** Most recent Studio activity (pipeline or agent) for StatusBar chrome. */
  activityJob: PipelineJobSnapshot | null;
  activityRunningCount: number;
  isPlaying: boolean;
  /** Playhead when playback last started; Stop returns here. A seek while not playing and Stop itself reset it to null. */
  playStartSec: number | null;
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
  layoutMode: LayoutMode;
  sheetExpanded: boolean;
  laneHeightMode: LaneHeightMode;
  laneHeightPx: number;
  /** Lane height the mounted timeline last resolved (fit or fixed); null with no timeline. Stepping from fit mode starts here. */
  drawnLaneHeightPx: number | null;
  /** Keyboard shortcuts palette open. */
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
  /** The drawn join whose popover is open (its right clip's id), or null. One at a time (timeline/JoinBadge.tsx). */
  openJoinId: string | null;
  /**
   * A join popover's SetClipJoin is in flight: no join popover dismisses, opens or switches until it settles
   * (timeline/JoinPopover.tsx); a project switch clears it. Store state, not a module `let` like
   * commands/tighten.ts `tightenMutationInFlight`, because sibling JoinBadges render from it. A third such
   * guard should share a helper with these two.
   */
  joinMutationInFlight: boolean;
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
  /**
   * Result copy owed by jobs whose callers announce their own outcome (#704):
   * `useJobStatusAnnouncement` holds back the generic "ok" headline for these
   * jobs and speaks the copy once it arrives. Reset by a project switch (hydrate).
   */
  pendingJobResults: PendingJobResults;
  /**
   * Jobs whose own result copy `useJobStatusAnnouncement` has spoken, oldest
   * first, capped at `SPOKEN_JOB_RESULT_LIMIT`. This is a list, not one slot,
   * for two reasons: one pass can speak several results, and a later result
   * for another job must not un-mark the chip's own job. It is kept in the
   * store rather than the hook, so a remount (desktop <-> phone shell) does
   * not speak the generic headline over a result already spoken (#704).
   * Reset by a project switch (hydrate).
   */
  spokenJobResultIds: readonly string[];
  /** Presence roster from session Snapshot / Presence events, keyed by `client_id`
   * (#598: a `PresenceDelta` replaces only its own entry). */
  sessionClients: SessionRoster;
  /** One process-wide monotonic roster version (#598's client apply rule). */
  sessionRosterVersion: number;
  setSessionClients: (clients: SessionClient[], rosterVersion?: number) => void;
  /** Apply one `PresenceDelta`. Returns `true` when the caller should send a
   * `RosterRequest` (a stale/unknown version - `presence/roster.ts`'s `applyPresenceDelta`). */
  applyPresenceDelta: (
    authorClientId: string,
    changes: PresenceDeltaChanges,
    rosterVersion: number,
  ) => boolean;
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
  setTranscriptInlineCommitPending: (pending: boolean) => void;
  setTranscriptInlineEditFailure: (
    failure: TranscriptInlineEditFailure | null,
  ) => void;
  setTranscriptReviewCursor: (cursor: TranscriptReviewCursor | null) => void;
  setChapterAddPending: (pending: boolean) => void;
  setTranscriptAnnotate: (on: boolean) => void;
  toggleTranscriptAnnotate: () => void;
  setShowCutAwayUtterances: (on: boolean) => void;
  toggleShowCutAwayUtterances: () => void;
  setPipelineJob: (job: PipelineJobSnapshot | null) => void;
  setActivityJob: (job: PipelineJobSnapshot | null) => void;
  setActivityRunningCount: (count: number) => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  /** Stop: halt and return to playStartSec clamped to the timeline, then forget it (Pause keeps the position). */
  stopPlayback: () => void;
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
   * Clamp zoom and keep time under clientX stable. Without clientX (command
   * zoom) it anchors on the playhead when it is inside the time viewport, else
   * the last noted timeline pointer X (`noteZoomPointerClientX`), then viewport
   * center.
   * On a fixed playhead (a lead is registered), command zoom with no clientX
   * centers on the playhead instead, and every zoom stays within the session.
   */
  applyAnchoredZoom: (nextZoom: number, clientX?: number) => void;
  setWaveformAmpZoom: (amp: number) => void;
  nudgeWaveformAmp: (direction: "in" | "out") => void;
  setWaveformScale: (mode: WaveformScaleMode) => void;
  setWaveformPostFader: (on: boolean) => void;
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
  measureTimelineViewport: () => number;
  /** Also re-stores `timelineViewportWidth` from the live timeline or the new shell's estimate. */
  setShellBreakpoint: (bp: ShellBreakpoint) => void;
  setPointerKind: (kind: PointerKind) => void;
  setMobileMode: (mode: MobileMode) => void;
  setMoreDestination: (dest: MoreDestination) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  setSheetExpanded: (on: boolean) => void;
  setLaneHeightMode: (mode: LaneHeightMode) => void;
  toggleFitTracksHeight: () => void;
  stepLaneHeight: (direction: "up" | "down") => void;
  setDrawnLaneHeightPx: (px: number | null) => void;
  setCommandPaletteOpen: (on: boolean) => void;
  setGesturesSheetOpen: (on: boolean) => void;
  toggleCommandPalette: () => void;
  setBounceDialogOpen: (on: boolean) => void;
  setShareDialogOpen: (on: boolean) => void;
  setRecordPanelOpen: (on: boolean) => void;
  setHostMcpDialogOpen: (on: boolean) => void;
  setHelpDialogOpen: (on: boolean) => void;
  setOpenJoinId: (id: string | null) => void;
  setJoinMutationInFlight: (on: boolean) => void;
  setHighlightStaleRender: (on: boolean) => void;
  setRenderPreviewBusy: (on: boolean) => void;
  setIngestBusy: (on: boolean) => void;
  setIngestDropTrackId: (trackId: string | null) => void;
  announceStatus: (message: string) => void;
  /** Mark a job whose caller will post its own result copy (holds back its generic "ok" headline). */
  expectJobResult: (jobId: string) => void;
  /** Hand over a job's own result copy for `useJobStatusAnnouncement` to speak. */
  announceJobResult: (jobId: string, message: string) => void;
  /** Drop a job's pending result (spoken, failed or aborted). */
  settleJobResult: (jobId: string) => void;
  /** In one store write, drop these jobs' pending results and remember them as spoken (see `spokenJobResultIds`). */
  markJobResultsSpoken: (jobIds: readonly string[]) => void;
}

/** Internal state shared by the four slice creators. DOM refs live outside Zustand. */
export interface DawStore extends DawState {
  _suppressTimer: number | null;
  hydrate: (
    projectPath: string,
    initialProject: ProjectView | null,
    guestMode?: string | null,
    shareCapabilities?: string[] | null,
  ) => void;
}
