import type { PresenceDeltaChanges, SessionRoster } from "../presence/roster";
import type { RoutedTarget } from "../timeline/hitRouting";
import type { PendingJobResults, PipelineJobSnapshot } from "../types/pipeline";
import type {
  AutomationPoint,
  HistoryEntryId,
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
  SessionSelection,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";
import type { CompactInspectorView } from "../utils/compactInspectorPref";
import type { LaneHeightMode } from "../utils/laneHeightPref";
import type { WaveformScaleMode } from "../waveform/types";
import type {
  HeldTrimEvent,
  HeldTrimLayer,
  HeldTrimResult,
} from "./projectSlice";

/** Open/closed state of the app's dialogs, sheets and inline panels; only the palette and gestures sheet exclude each other. */
export interface ChromeFlags {
  /** Command palette (Commands and shortcuts) open. */
  commandPaletteOpen: boolean;
  /** Mobile gestures cheatsheet open. */
  gesturesSheetOpen: boolean;
  /** Bounce dialog open (host export/bounces). */
  bounceDialogOpen: boolean;
  /** Host Export deliverables dialog (configure, progress, outcome). */
  exportDialogOpen: boolean;
  /** Host share management dialog. */
  shareDialogOpen: boolean;
  /** Host record-room control panel. */
  recordPanelOpen: boolean;
  /** Local host MCP connect dialog (Streamable HTTP URL). */
  hostMcpDialogOpen: boolean;
  /** Host Help → diagnostics bundle dialog. */
  helpDialogOpen: boolean;
  /** Transcript find/replace panel open. */
  transcriptFindReplaceOpen: boolean;
}

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
  sourceId?: string | null;
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
  sourceId?: string | null;
  wordIndex: number;
  /** `LowConfidenceStop.order` when visited: once this word leaves the list (corrected, maybe in a batch), the walk resumes at the nearest stop after / before it in transcript order. */
  order: number;
}

export interface TranscriptInlineEditRequest {
  projectPath: string;
  trackId: string;
  sourceId?: string | null;
  wordIndex: number;
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

/** The envelope point form's text. */
export type EnvelopeForm = {
  kind: "add" | "edit";
  pointId: string;
  time: string;
  level: string;
  notice?: string;
};

/** An open envelope point form and the baseline it was opened against. */
export type EnvelopeDraft = {
  form: EnvelopeForm;
  origin: AutomationPoint[];
  endpointIds: { start: string; end: string } | null;
};

/**
 * An open envelope point draft and the target it belongs to. It lives in the
 * store, not in the form, so it outlives the phone and tablet shells swapping
 * on rotation; `dawStore` drops it when the selection leaves its target.
 */
export type EnvelopeDraftEntry = {
  projectPath: string;
  projectEpoch: number;
  trackId: string;
  /** The selected point of the workspace that opened it; null for the track's envelope. */
  pointId: string | null;
  draft: EnvelopeDraft;
};

/**
 * The envelope save in flight and the target it writes. It lives in the store,
 * not in the form, so a remount (the phone and tablet shells swapping on
 * rotation) neither enables a second Save nor loses the busy state.
 */
export type EnvelopeSaving = {
  projectPath: string;
  projectEpoch: number;
  trackId: string;
};

/**
 * Typed but unsaved word-editor fields and the word they belong to. It lives
 * in the store, not in the inspector, so it outlives the shells swapping on
 * rotation; `dawStore` drops it when the selection leaves its word.
 */
export type WordDraftEntry = {
  projectPath: string;
  projectEpoch: number;
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
  text: string;
  endIndexStr: string;
  /** The span text the draft was checked against (#650); Apply still sends this snapshot. */
  expectedText: string | null;
};

export interface CommentDraft {
  startSec: number;
  endSec: number | null;
  trackIds?: string[];
  intervals?: { start: number; end: number }[];
}

type SourcePreviewBase = {
  ownerId: string;
  projectEpoch: number;
  startSec: number;
  endSec: number;
  generation: number;
  playing: boolean;
};

export type SourcePreviewRequest = SourcePreviewBase &
  (
    | {
        media: {
          kind: "raw";
          trackId: string;
          sourceId: string | null;
          cacheKey: string;
        };
      }
    | { media: { kind: "rendered"; url: string } }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type SourcePreviewStartRequest = DistributiveOmit<
  SourcePreviewRequest,
  "generation" | "playing" | "projectEpoch"
>;
export type SourcePreviewError = {
  kind: "blocked" | "unavailable";
  message: string;
};

/** How a toast looks and what it asks of the person: a result, or a failure with a next step. */
export type ToastTone = "status" | "error";

/** An Undo that is not a History step (a comment resolve); `run` reports whether it took effect. */
export interface ReverseAction {
  run: () => Promise<boolean>;
  /** Announced after `run` succeeds. */
  done: string;
}

/** The visible twin of an announcement, with its Undo while one is valid. */
export interface FeedbackToast {
  id: number;
  message: string;
  tone: ToastTone;
  /** The history entry this change recorded; Undo shows while it is still the head. */
  undo: HistoryEntryId | null;
  /**
   * The head this tab showed when it announced. The change's own reply can
   * reach the toast before the project shows its entry, so Undo also waits
   * while the head is still this one.
   */
  baseHead: HistoryEntryId | null;
  /** Undo for a change History does not record. */
  reverse: ReverseAction | null;
  /** Where focus goes when its Undo or Dismiss closes the toast; the panel the change was made in. */
  returnFocus: (() => HTMLElement | null) | null;
  /** Says what a gesture is doing; it clears when the gesture ends or the mode changes. */
  gesture: boolean;
}

export interface AnnounceOptions {
  /** Offer Undo on the toast for this entry (the command reply's `replyHistoryHead`). */
  undo?: HistoryEntryId | null;
  /** Offer Undo for a change History does not record. */
  reverse?: ReverseAction;
  returnFocus?: () => HTMLElement | null;
  /** `error` names a failure and its next step; internals are replaced before it is shown. */
  tone?: ToastTone;
  /** The message belongs to the running gesture (see `FeedbackToast.gesture`). */
  gesture?: true;
  /** False when a persistent control already shows this status (the job chip), so only the live region speaks it. */
  toast?: false;
}

/** Public DAW API — same shape as the former Context value. */
export interface DawState {
  sourcePreview: SourcePreviewRequest | null;
  sourcePreviewGeneration: number;
  sourcePreviewPositionSec: number | null;
  sourcePreviewError: SourcePreviewError | null;

  project: ProjectView | null;
  heldTrim: HeldTrimLayer | null;
  projectEditBasis: () => ProjectView | null;
  changeHeldTrim: (event: HeldTrimEvent) => HeldTrimResult;
  projectPath: string;
  /** Changes when the viewer opens a different project, even if it later returns. */
  projectEpoch: number;
  /** Share guest mode from bootstrap; null for host. */
  guestMode: string | null;
  /** Share capability list from bootstrap; null for host. */
  shareCapabilities: string[] | null;
  /** This guest's share author (``PendingEditView.author``) from bootstrap; null for host. */
  shareAuthor: string | null;
  playheadSec: number;
  playheadSeekRevision: number;
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
  /** The one selection: every selected target, one kind. `selection.ts` derives the track and clip sets from it. */
  selection: Selection;
  rangeArmed: boolean;
  /** The tracks ticked for a range not yet formed; null follows the selection. */
  rangeScopeTrackIds: readonly string[] | null;
  rangeBusy: boolean;
  setRangeArmed: (armed: boolean) => void;
  setRangeScopeTrackIds: (trackIds: readonly string[] | null) => void;
  setRangeBusy: (busy: boolean) => void;
  activeTab: DawTab;
  userZoomed: boolean;
  layers: LayerVisibility;
  commentMode: boolean;
  commentDraft: CommentDraft | null;
  envelopeDraft: EnvelopeDraftEntry | null;
  envelopeSaving: EnvelopeSaving | null;
  wordDraft: WordDraftEntry | null;
  transcriptFollowPlayhead: boolean;
  transcriptAnnotate: boolean;
  /** The Transcript panel is in Correct intent: a tapped word edits its text, not the audio. */
  transcriptCorrecting: boolean;
  transcriptTimingRequest: TranscriptInlineEditRequest | null;
  transcriptInlineEditRequest: TranscriptInlineEditRequest | null;
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
  /** Phone: pending blade cut time awaiting confirm sheet. */
  /** A ripple the host refused because it would cut other speech, awaiting the person's choice. */
  audioError: string | null;
  sessionRegion: SessionRegion | null;
  lastAgentQuery: string | null;
  playUntilSec: number | null;
  lastAppliedRevision: number;
  lastAppliedCommandId: string | null;
  /** Newest `agent_selection_seq` this tab has adopted, so an agent selection applies once. */
  lastAppliedAgentSelectionSeq: number;
  suppressPublish: boolean;
  /** A remote selection whose target this client does not have yet; resolved when the project arrives or changes. */
  pendingWireSelection: SessionSelection | null;
  /** Bumped by every selection that arrived from the wire, so a listener can tell it from the person's own navigation. */
  remoteSelectionRevision: number;
  shellBreakpoint: ShellBreakpoint;
  pointerKind: PointerKind;
  mobileMode: MobileMode;
  moreDestination: MoreDestination;
  layoutMode: LayoutMode;
  sheetExpanded: boolean;
  /** Compact (phone) inspector: open as the peek strip or expanded; persisted. */
  compactInspectorView: CompactInspectorView;
  /** The timeline target the last press went to (touch input grammar). */
  selectionHit: RoutedTarget | null;
  inspectorSelection: Selection;
  /** A timeline drag is under way; the compact inspector stows itself. */
  timelineDragging: boolean;
  laneHeightMode: LaneHeightMode;
  laneHeightPx: number;
  /** Lane height the mounted timeline last resolved (fit or fixed); null with no timeline. Stepping from fit mode starts here. */
  drawnLaneHeightPx: number | null;
  chrome: ChromeFlags;
  bounceRangeTarget: import("../types/project").ExactRangeTarget | null;
  setBounceRangeTarget: (
    target: import("../types/project").ExactRangeTarget | null,
  ) => void;
  splitSpeakersReview: {
    trackId: string;
    splitId: string;
    historyHeadId: HistoryEntryId;
  } | null;
  setSplitSpeakersReview: (
    review: {
      trackId: string;
      splitId: string;
      historyHeadId: HistoryEntryId;
    } | null,
  ) => void;
  /** Track the Split speakers dialog is open for; null while it is closed. */
  splitSpeakersTrackId: string | null;
  /** Tighten tab Apply-eligible scope for keyboard shortcuts. */
  tightenApplyScope: { ids: string[] };
  setTightenApplyScope: (scope: { ids: string[] }) => void;
  /** The drawn join whose popover is open (its right clip's id), or null. One at a time (timeline/JoinBadge.tsx). */
  openJoinId: string | null;
  /**
   * A join popover's SetClipJoin is in flight: no join popover dismisses, opens or switches until it settles
   * (timeline/JoinPopover.tsx); a project switch clears it. Store state lets sibling JoinBadges render from it.
   */
  joinMutationInFlight: boolean;
  /**
   * The ripple trim a drag or a focused handle's arrows are previewing, or
   * null. Every lane it ripples draws where its later clips go
   * (edit/ripplePreview.ts); a project switch clears it.
   */
  rippleTrim: import("../edit/ripplePreview").RippleTrim | null;
  /** Hover/focus Stale pill → highlight stale lanes on the timeline. */
  highlightStaleRender: boolean;
  /** Refresh-mix / render_preview in flight. */
  renderPreviewBusy: boolean;
  /** Audio import / track ingest in flight. */
  ingestBusy: boolean;
  /** Track id highlighted while dragging audio over a lane (TCP sync). */
  ingestDropTrackId: string | null;
  /** Polite live-region status: the last announcement. */
  statusAnnouncement: string;
  /**
   * Counts announcements. `StatusLiveRegion` keys its text on it, so a
   * repeated message is spoken again; the toast uses it as its id.
   */
  statusAnnouncementSeq: number;
  /** Visible twin of the last announcement that has one; null once dismissed. */
  feedbackToast: FeedbackToast | null;
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
  setPlayheadSec: (sec: number, origin?: "seek" | "playback") => void;
  /** Set zoom, clamped to the session-aware ceiling. */
  setZoomPxPerSec: (z: number) => void;
  setScrollLeft: (x: number) => void;
  setSelection: (sel: Selection) => void;
  selectFromInspector: (sel: Selection) => void;
  selectClip: (
    clipId: string,
    trackId: string,
    mods?: { shift?: boolean; mod?: boolean },
  ) => void;
  setActiveTab: (tab: DawTab) => void;
  setTranscriptFollowPlayhead: (on: boolean) => void;
  toggleTranscriptFollowPlayhead: () => void;
  setTranscriptTimingRequest: (
    request: TranscriptInlineEditRequest | null,
  ) => void;
  setTranscriptInlineEditRequest: (
    request: TranscriptInlineEditRequest | null,
  ) => void;
  setTranscriptInlineCommitPending: (pending: boolean) => void;
  setTranscriptInlineEditFailure: (
    failure: TranscriptInlineEditFailure | null,
  ) => void;
  setTranscriptReviewCursor: (cursor: TranscriptReviewCursor | null) => void;
  setChapterAddPending: (pending: boolean) => void;
  setTranscriptAnnotate: (on: boolean) => void;
  setTranscriptCorrecting: (on: boolean) => void;
  toggleTranscriptAnnotate: () => void;
  setShowCutAwayUtterances: (on: boolean) => void;
  toggleShowCutAwayUtterances: () => void;
  setPipelineJob: (job: PipelineJobSnapshot | null) => void;
  setActivityJob: (job: PipelineJobSnapshot | null) => void;
  setActivityRunningCount: (count: number) => void;
  beginSourcePreview: (request: SourcePreviewStartRequest) => void;
  updateSourcePreview: (
    ownerId: string,
    generation: number,
    positionSec: number,
    stopped?: boolean,
    error?: SourcePreviewError,
  ) => void;
  releaseSourcePreview: (ownerId: string) => void;
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
  /** Adopt a selection another client or the agent made; not the person's own navigation. */
  adoptRemoteSelection: (
    selection: Selection,
    pendingWireSelection?: SessionSelection | null,
  ) => void;
  clearSessionRegion: () => void;
  setPlayUntilSec: (sec: number | null) => void;
  beginAudition: (opts: { playheadSec: number; untilSec: number }) => void;
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
  setEnvelopeDraft: (entry: EnvelopeDraftEntry | null) => void;
  setEnvelopeSaving: (saving: EnvelopeSaving | null) => void;
  setWordDraft: (entry: WordDraftEntry | null) => void;
  setToolMode: (mode: ToolMode) => void;
  selectTracks: (trackIds: readonly string[]) => void;
  toggleTrackSelected: (trackId: string, additive: boolean) => void;
  fitToWindow: (viewportWidth: number) => void;
  measureTimelineViewport: () => number;
  /** Also re-stores `timelineViewportWidth` from the live timeline or the new shell's estimate. */
  setShellBreakpoint: (bp: ShellBreakpoint) => void;
  setPointerKind: (kind: PointerKind) => void;
  setMobileMode: (mode: MobileMode) => void;
  setMoreDestination: (dest: MoreDestination) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  setSheetExpanded: (on: boolean) => void;
  setCompactInspectorView: (view: CompactInspectorView) => void;
  setSelectionHit: (hit: RoutedTarget | null) => void;
  setTimelineDragging: (on: boolean) => void;
  setLaneHeightMode: (mode: LaneHeightMode) => void;
  toggleFitTracksHeight: () => void;
  stepLaneHeight: (direction: "up" | "down") => void;
  setDrawnLaneHeightPx: (px: number | null) => void;
  setCommandPaletteOpen: (on: boolean) => void;
  setGesturesSheetOpen: (on: boolean) => void;
  toggleCommandPalette: () => void;
  setBounceDialogOpen: (on: boolean) => void;
  setTranscriptFindReplaceOpen: (on: boolean) => void;
  setExportDialogOpen: (on: boolean) => void;
  setSplitSpeakersTrackId: (trackId: string | null) => void;
  setShareDialogOpen: (on: boolean) => void;
  setRecordPanelOpen: (on: boolean) => void;
  setHostMcpDialogOpen: (on: boolean) => void;
  setHelpDialogOpen: (on: boolean) => void;
  setOpenJoinId: (id: string | null) => void;
  setJoinMutationInFlight: (on: boolean) => void;
  setRippleTrim: (
    trim: import("../edit/ripplePreview").RippleTrim | null,
  ) => void;
  setHighlightStaleRender: (on: boolean) => void;
  setRenderPreviewBusy: (on: boolean) => void;
  setIngestBusy: (on: boolean) => void;
  setIngestDropTrackId: (trackId: string | null) => void;
  /** Speak `message` in the live region and show it as a toast (see `AnnounceOptions`). */
  announceStatus: (message: string, options?: AnnounceOptions) => void;
  /** Clears the toast a gesture raised, when that gesture ends. */
  endGestureFeedback: () => void;
  /** Close the toast if it is still `id`. */
  dismissFeedbackToast: (id: number) => void;
  /** Remove the toast's Undo once history has moved past its change. */
  dropFeedbackUndo: (id: number) => void;
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
    shareAuthor?: string | null,
  ) => void;
}
