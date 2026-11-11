import type { RippleTrim } from "../edit/ripplePreview";
import type { PresenceDeltaChanges, SessionRoster } from "../presence/roster";
import type { RoutedTarget } from "../timeline/hitRouting";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type {
  ClipRow,
  ExactRangeTarget,
  HistoryEntryId,
  ProjectView,
  Selection,
  TimelineSpan,
  TranscriptWordBooleanFlag,
} from "../types/project";
import type {
  AuditionMode,
  PresenceTab,
  SessionClient,
  SessionRegion,
  SessionSelection,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";
import type { LaneHeightMode } from "../utils/laneHeightPref";
import type { WaveformScaleMode } from "../waveform/types";
import type { AfterCutSliceState } from "./afterCutSlice";
import type {
  HeldTrimEvent,
  HeldTrimLayer,
  HeldTrimResult,
} from "./projectSlice";
import type { StageSliceState } from "./stageSlice";

/** A person kept in the Person picker after their last track went to someone else. */
export type KnownPerson = {
  id: string;
  name: string;
  colorIndex: number;
};

export type HelpStep = "menu" | "report";

export type RangeDraft = TimelineSpan & { trackIds: readonly string[] };

/** Open/closed state of the app's dialogs, sheets and inline panels. */
export interface ChromeFlags {
  /** Command palette (Commands and shortcuts) open. */
  commandPaletteOpen: boolean;
  /** An export asked for by a command; the Deliver stage starts it and clears this. */
  exportRequested: boolean;
  transcriptRequested: boolean;
  /** Local host MCP connect dialog (Streamable HTTP URL). */
  hostMcpDialogOpen: boolean;
  /** Host Help → diagnostics bundle dialog. */
  helpDialogOpen: boolean;
  /** Entry step the opener requests; the sheet owns the step once open. */
  helpDialogStep: HelpStep;
  /** Models sheet: every model, its state and download. */
  modelsSheetOpen: boolean;
  /** Settings sheet: Appearance, Saved in, Models and Keyboard shortcuts. */
  settingsSheetOpen: boolean;
  /** Transcript find/replace panel open. */
  transcriptFindReplaceOpen: boolean;
}

export type { AuditionMode } from "../types/session";
export type { LaneHeightMode } from "../utils/laneHeightPref";

export interface LayerVisibility {
  showLevels: boolean;
  showSilence: boolean;
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
  /** Fix text on this run of words in the track; left out, the one word. */
  endWordIndex?: number;
}

export type DawTab = PresenceTab;

export type ShellBreakpoint = "phone" | "tablet" | "desktop";

/**
 * Last-used pointing device kind: fine (mouse/pen) vs coarse (touch).
 * Tracked live from Pointer Events; drives input-mode adaptation (e.g. the
 * presence `mobile_mode` payload), never presence visibility.
 */
export type PointerKind = "fine" | "coarse";

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

/**
 * An Undo that is not a History step (a comment resolve). `run` reports whether it took
 * effect; a string is a refusal, announced as the error in place of the generic one.
 */
export interface ReverseAction {
  run: () => Promise<boolean | string>;
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
  onUndone?: () => void;
  /** Where focus goes when its Undo or Dismiss closes the toast; the panel the change was made in. */
  returnFocus: (() => HTMLElement | null) | null;
  /** How long the toast stays up, when the Undo it offers expires on a clock of its own; null for the usual dwell. */
  dwellMs: number | null;
  /** Says what a gesture is doing; it clears when the gesture ends or the mode changes. */
  gesture: boolean;
  action: ToastAction | null;
  /** What kind of edit the toast reports; consecutive edits of one kind merge. */
  kind: ToastKind | null;
  /** The edits folded into this toast, newest first (`entries[0]` is `undo`); null for a lone edit. */
  merged: MergedEdits | null;
  /**
   * The edits this toast offered Undo for when the head moved past them (usually
   * the next edit of the same kind landing). The next edit of that kind folds into
   * them within a moment; otherwise they are history.
   */
  lapsed: { entries: readonly HistoryEntryId[]; at: number } | null;
}

export type ToastKind = "cut" | "delete" | "split";

export interface MergedEdits {
  /** Newest first; `entries[0]` is the toast's `undo`. */
  entries: readonly HistoryEntryId[];
}

export type AnnouncedJobKind = "export" | "bounce";
export type JobStartToken = Readonly<{
  identity: symbol;
  projectEpoch: number;
}>;
export type JobResultOwner = Readonly<{
  start: JobStartToken;
  jobId: string;
}>;
export type JobResultOutcome =
  | { kind: "verified"; copy: string; action?: ToastAction }
  | { kind: "failure"; copy: string }
  | { kind: "cancelled-empty" };
export type JobFeedback =
  | { kind: "deferred"; copy: string; blockers: ReadonlySet<JobStartToken> }
  | { kind: "known" }
  | { kind: "following"; owner: JobResultOwner }
  | {
      kind: "ready";
      outcome: Exclude<JobResultOutcome, { kind: "cancelled-empty" }>;
    }
  | { kind: "unverified" }
  | { kind: "failure-delivered" };
export type JobChipObservation = Readonly<{
  id: string | undefined;
  kind: string | undefined;
  status: PipelineJobSnapshot["status"];
  copy: string;
}>;

export type ToastAction = {
  label: string;
  run: () => void | Promise<void>;
};

export interface AnnounceOptions {
  action?: ToastAction;
  /** Edits of the same kind announced back to back fold into one toast. */
  kind?: ToastKind;
  /** Offer Undo on the toast for this entry (the command reply's `replyHistoryHead`). */
  undo?: HistoryEntryId | null;
  /** Offer Undo for a change History does not record. */
  reverse?: ReverseAction;
  /** Runs only after Undo moved the History head, not on a refusal or failure. */
  onUndone?: () => void;
  returnFocus?: () => HTMLElement | null;
  /** Stays up this long (not hovered or focused) instead of the usual dwell: for an Undo the server stops honoring. */
  dwellMs?: number;
  /** `error` names a failure and its next step; internals are replaced before it is shown. */
  tone?: ToastTone;
  /** The message belongs to the running gesture (see `FeedbackToast.gesture`). */
  gesture?: true;
  /** False when a persistent control already shows this status (the job chip), so only the live region speaks it. */
  toast?: false;
}

type ChapterSelection = Extract<Selection, { kind: "chapter" }>;

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
  /** The review episode's overview-strip envelope (0..1 columns); empty for a host or until loaded. */
  reviewPeaks: readonly number[];
  playheadSec: number;
  playheadSeekRevision: number;
  zoomPxPerSec: number;
  waveformAmpZoom: number;
  /** Waveform scale: auto (dialogue in dB), linear or log; remembered per project. */
  waveformScale: WaveformScaleMode;
  /** Draw waveforms scaled by each track's output gain (gain_db + fader_db). */
  waveformPostFader: boolean;
  pointerTrackId: string | null;
  /** Split guide time (s) under the pointer while Alt is held over the lanes; null otherwise. */
  splitHoverSec: number | null;
  scrollLeft: number;
  /** Visible time column (px) of the mounted timeline, from its observer; the shell estimate before it measures and after it unmounts. */
  timelineViewportWidth: number;
  /** The one selection: every selected target, one kind. `selection.ts` derives the track and clip sets from it. */
  selection: Selection;
  rangeArmed: boolean;
  rangeDraft: RangeDraft | null;
  /**
   * The tracks picked before any span exists. A `RangeDraft` needs a span, so
   * it cannot hold them. Kept across agent-region changes, so a pick waits for
   * the range it is for.
   */
  agentRangeScope: readonly string[] | null;
  rangeBusy: boolean;
  /**
   * The selection the Inspector was opened for (`inspectKeyOf`), or null. It
   * is open only while the selection still has that key, so Inspect (I, the
   * verb, a double-click) opens it and a new selection, Esc or Close shuts it.
   */
  inspectorKey: string | null;
  setInspectorOpen: (open: boolean) => void;
  moreRequest: number;
  requestMore: () => void;
  setRangeArmed: (armed: boolean) => void;
  armRange: (draft: RangeDraft) => void;
  setRangeDraft: (draft: RangeDraft) => void;
  setAgentRangeScope: (ids: readonly string[]) => void;
  setRangeBusy: (busy: boolean) => void;
  userZoomed: boolean;
  layers: LayerVisibility;
  commentDraft: CommentDraft | null;
  transcriptFollowPlayhead: boolean;
  transcriptInlineEditRequest: TranscriptInlineEditRequest | null;
  /** Late failure of an inline word fix; outlives a Script remount. */
  transcriptInlineEditFailure: TranscriptInlineEditFailure | null;
  /** `edit.addChapter` (plus menu, touch create menu) is in flight for the current project; outlives a menu remount, reset by a project switch (hydrate). */
  chapterAddPending: boolean;
  showCutAwayUtterances: boolean;
  pipelineJob: PipelineJobSnapshot | null;
  /** Most recent Studio activity (pipeline or agent) for the stage chrome. */
  activityJob: PipelineJobSnapshot | null;
  activityRunningCount: number;
  isPlaying: boolean;
  /** Playhead when playback last started; Stop returns here. A seek while not playing and Stop itself reset it to null. */
  playStartSec: number | null;
  auditionMode: AuditionMode;
  viewerMute: Record<string, boolean>;
  soloTracks: Record<string, boolean>;
  timelineFocused: boolean;
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
  /** The timeline target the last press went to (touch input grammar). */
  selectionHit: RoutedTarget | null;
  inspectorSelection: Selection;
  /** A timeline drag is under way; the compact inspector stows itself. */
  timelineDragging: boolean;
  snapEnabled: boolean;
  laneHeightMode: LaneHeightMode;
  laneHeightPx: number;
  /** Lane height the mounted timeline last resolved (fit or fixed); null with no timeline. Stepping from fit mode starts here. */
  drawnLaneHeightPx: number | null;
  chrome: ChromeFlags;
  /** Source Prepare shows its split prompt for, set by "Split speakers…"; null otherwise. */
  prepareFocusTrackId: string | null;
  /**
   * A seam's SetClipJoin is in flight: clip edge handles and range gestures wait until it settles
   * (commands/seamCommands.ts); a project switch clears it.
   */
  joinMutationInFlight: boolean;
  /**
   * The selected seam's right clip as the length Scrub is drafting it, or
   * null: the join blend reads its tier and label from it.
   */
  joinDraft: ClipRow | null;
  /**
   * The ripple trim a drag or a focused handle's arrows are previewing, or
   * null. Every lane it ripples draws where its later clips go
   * (edit/ripplePreview.ts); a project switch clears it.
   */
  rippleTrim: RippleTrim | null;
  /** Hover/focus Stale pill → highlight stale lanes on the timeline. */
  highlightStaleRender: boolean;
  /** Refresh-mix / render_preview in flight. */
  renderPreviewBusy: boolean;
  /** Audio import / track ingest in flight. */
  ingestBusy: boolean;
  /** Files being imported while `ingestBusy`. */
  ingestFileCount: number;
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
   * People the Person picker keeps after a track was switched away from them,
   * so one can be picked again. Reset with the project.
   */
  knownPeople: readonly KnownPerson[];
  jobResultStarts: ReadonlyMap<JobStartToken, AnnouncedJobKind>;
  jobFeedback: ReadonlyMap<string, JobFeedback>;
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
  setReviewPeaks: (peaks: readonly number[]) => void;
  setPlayheadSec: (sec: number, origin?: "seek" | "playback") => void;
  /** Set zoom, clamped to the session-aware ceiling. */
  setZoomPxPerSec: (z: number) => void;
  setScrollLeft: (x: number) => void;
  setSelection: (sel: Selection) => void;
  followChapter: (from: ChapterSelection, to: ChapterSelection) => void;
  selectFromInspector: (sel: Selection) => void;
  selectClip: (
    clipId: string,
    trackId: string,
    mods?: { shift?: boolean; mod?: boolean },
  ) => void;
  setTranscriptFollowPlayhead: (on: boolean) => void;
  toggleTranscriptFollowPlayhead: () => void;
  setTranscriptInlineEditRequest: (
    request: TranscriptInlineEditRequest | null,
  ) => void;
  setTranscriptInlineEditFailure: (
    failure: TranscriptInlineEditFailure | null,
  ) => void;
  setChapterAddPending: (pending: boolean) => void;
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
  /** Clamp zoom and scroll so the span's midpoint is centered in the time viewport. */
  zoomToSpan: (startSec: number, endSec: number, nextZoom: number) => void;
  setWaveformAmpZoom: (amp: number) => void;
  nudgeWaveformAmp: (direction: "in" | "out") => void;
  setWaveformScale: (mode: WaveformScaleMode) => void;
  setWaveformPostFader: (on: boolean) => void;
  setPointerTrackId: (trackId: string | null) => void;
  setSplitHoverSec: (sec: number | null) => void;
  /** Stores a measured width; 0 or less stores the shell estimate instead. */
  setTimelineViewportWidth: (px: number) => void;
  /** Back to the current shell's estimate (the timeline unmounted). */
  resetTimelineViewportWidth: () => void;
  setLayerVisible: (key: keyof LayerVisibility, visible: boolean) => void;
  setCommentDraft: (draft: CommentDraft | null) => void;
  selectTracks: (trackIds: readonly string[]) => void;
  commitRange: (target: ExactRangeTarget) => void;
  toggleTrackSelected: (trackId: string, additive: boolean) => void;
  fitToWindow: (viewportWidth: number) => void;
  measureTimelineViewport: () => number;
  /** Also re-stores `timelineViewportWidth` from the live timeline or the new shell's estimate. */
  setShellBreakpoint: (bp: ShellBreakpoint) => void;
  setPointerKind: (kind: PointerKind) => void;
  setSelectionHit: (hit: RoutedTarget | null) => void;
  setTimelineDragging: (on: boolean) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setLaneHeightMode: (mode: LaneHeightMode) => void;
  toggleFitTracksHeight: () => void;
  stepLaneHeight: (direction: "up" | "down") => void;
  setDrawnLaneHeightPx: (px: number | null) => void;
  setCommandPaletteOpen: (on: boolean) => void;
  toggleCommandPalette: () => void;
  setTranscriptFindReplaceOpen: (on: boolean) => void;
  setExportRequested: (on: boolean) => void;
  setPrepareFocusTrackId: (trackId: string | null) => void;
  setTranscriptRequested: (on: boolean) => void;
  setHostMcpDialogOpen: (on: boolean) => void;
  setHelpDialogOpen: (on: boolean, step?: HelpStep) => void;
  setModelsSheetOpen: (on: boolean) => void;
  setSettingsSheetOpen: (on: boolean) => void;
  setJoinMutationInFlight: (on: boolean) => void;
  setJoinDraft: (draft: ClipRow | null) => void;
  setRippleTrim: (trim: RippleTrim | null) => void;
  setHighlightStaleRender: (on: boolean) => void;
  setRenderPreviewBusy: (on: boolean) => void;
  setIngestBusy: (on: boolean, fileCount?: number) => void;
  setIngestDropTrackId: (trackId: string | null) => void;
  rememberPerson: (person: KnownPerson) => void;
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
  beginJobResultStart: (kind: AnnouncedJobKind) => JobStartToken;
  bindJobResultStart: (owner: JobResultOwner) => boolean;
  finishJobResult: (
    owner: JobResultOwner,
    outcome: JobResultOutcome,
  ) => boolean;
  releaseJobResultStart: (start: JobStartToken, owner?: JobResultOwner) => void;
  reconcileJobAnnouncements: (
    observation: JobChipObservation | null,
    chipId: string | undefined,
    chipTerminal: boolean,
  ) => void;
  /** Release Prepare's known-ID expectation after failure or cancellation. */
  settleJobResult: (jobId: string) => void;
  /** Consume acknowledged results and remember them across shell remounts. */
  markJobResultsSpoken: (jobIds: readonly string[]) => void;
}

/** Internal state shared by the four slice creators. DOM refs live outside Zustand. */
export interface DawStore
  extends DawState,
    StageSliceState,
    AfterCutSliceState {
  _suppressTimer: number | null;
  hydrate: (
    projectPath: string,
    initialProject: ProjectView | null,
    guestMode?: string | null,
    shareCapabilities?: string[] | null,
    shareAuthor?: string | null,
  ) => void;
}
