import type {
  ClipJoinMode,
  ClipMuteRegion,
  ExactRangeTarget as GeneratedExactRangeTarget,
  ProjectView as GeneratedProjectView,
  TrackView as GeneratedTrackView,
  RangeInterval,
  TranscriptRefineStatusView,
} from "./project.generated";

export type { ClipMuteRegion, RoomToneFill } from "./project.generated";

/** The transcript check the host reads; the server always sends every field. */
export type TranscriptCheckStatus = Required<TranscriptRefineStatusView>;

export interface OffSpeakerMuteRegion {
  start_s: number;
  end_s: number;
  fade_out_ms?: number;
  fade_in_ms?: number;
}

export type TimelineSpan = RangeInterval;

/** Encoder-detected sample-peak clipping, in source seconds. */
export interface ClippingRegion {
  start_s: number;
  end_s: number;
}

export type JoinMode = ClipJoinMode;

/** Why a crossfade-mode join renders without an overlap. */
export type CrossfadeBlocked =
  | "not_abutting"
  | "no_fade_out"
  | "no_fade_in"
  | "no_headroom";

export interface ClipRow {
  id: string;
  track_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  fade_in_ms: number;
  fade_out_ms: number;
  join_in_mode: string;
  /** Clip on the same track this join is with; null for a track's first clip (older servers omit it). */
  join_left_clip_id?: string | null;
  /** What render does at this join: the mode, or a crossfade that has nothing to blend. */
  join_render_mode?: string | null;
  /** Overlap render uses at this join (0 when it is not a crossfade). */
  join_crossfade_ms?: number;
  join_crossfade_blocked?: CrossfadeBlocked | null;
  /**
   * Seconds each side of this join borrows from its recording (half the overlap);
   * 0 when the join does not blend. `clips_ops.crossfade_borrow_sec`.
   */
  join_borrow_sec?: number;
  source_id: string | null;
  /**
   * Length (s) of the recording this clip plays; null when unmeasured. A trim
   * stops the out edge there (`engines/clips_ops.trim_edge_limits`).
   */
  source_duration_sec: number | null;
  /**
   * Opaque identity of that recording; null when it has none. Clips with the same key
   * play the same file, whatever their `source_id`. It names no file, so a share guest
   * learns no file name.
   */
  recording_key: string | null;
  origin_track_id?: string | null;
  mute_regions?: ClipMuteRegion[];
  /** Mutes the render adds for transcript-ignored words (#633); derived, not stored on the clip. */
  ignored_word_regions?: ClipMuteRegion[];
  /** Automatic off-speaker mutes (source seconds), fully silent between their fades; render-time, stored on the clip. */
  off_speaker_mute_regions?: OffSpeakerMuteRegion[];
  /** Source spans where the recording clipped, inside this clip window. */
  clipping_regions?: ClippingRegion[];
  /** The recording hit its clip-region cap; clipping after this clip's last flag was not recorded. */
  clipping_truncated?: boolean;
}

export type ExactRangeClip = Pick<
  ClipRow,
  | "id"
  | "track_id"
  | "source_id"
  | "source_start"
  | "source_end"
  | "timeline_start"
  | "fade_in_ms"
  | "fade_out_ms"
  | "join_in_mode"
> & { mute_regions: ClipMuteRegion[] };

export interface ExactRangeTarget
  extends Omit<GeneratedExactRangeTarget, "kind" | "clips"> {
  kind: "exact_range";
  clips: ExactRangeClip[];
}

/** Fields the server always sends; the generated model defaults them, so they read optional. */
type TrackViewSent =
  | "speaker"
  | "gain_db"
  | "muted"
  | "duration_sec"
  | "fx_count"
  | "stem_is_fresh";

export type TrackView = Omit<GeneratedTrackView, TrackViewSent> &
  Required<Pick<GeneratedTrackView, TrackViewSent>>;

export interface PendingJoinRisk {
  verdict: "pass" | "review" | "fail";
  label?: string | null;
  source?: string;
  risk?: number | null;
}

/**
 * What a pending edit is, as the server groups it (`edits/cut_policy.py::review_kind`).
 * The client never parses `reason` to group. The Review stage keeps its own `DecisionKind` and maps from this.
 * `other` covers guest suggestions and agent or manual edits.
 * Unsure words are NOT a kind: they are a separate per-edit list added by a later slice.
 */
export type PendingKind =
  | "filler"
  | "pause"
  | "repeat"
  | "false-start"
  | "sound"
  | "other";

/**
 * The raw sound the detector heard (`edits/cut_policy.py::sound_kind`); drives the Sound card variant.
 * Only filler, pause, repetition, restart, acoustic, laugh and possible_word are ever sent today;
 * backchannel, breath, mouth_click and playful_phrase are policy-table rows no reason code produces.
 */
export type PendingSoundKind =
  | "filler"
  | "pause"
  | "repetition"
  | "restart"
  | "acoustic"
  | "laugh"
  | "possible_word"
  | "backchannel"
  | "breath"
  | "mouth_click"
  | "playful_phrase";

export interface PendingEditView {
  exact_range?: ExactRangeTarget | null;
  id: string;
  track_id: string;
  track_ids?: string[];
  type: string;
  reason: string | null;
  /** ``share:`` plus the authoring share's opaque id; null for host and agent edits. */
  author?: string | null;
  source_start: number | null;
  source_end: number | null;
  /** Timeline clock of the stored source start, or null when clipped. */
  source_start_timeline: number | null;
  /** Timeline clock of the stored source end, or null when clipped. */
  source_end_timeline: number | null;
  timeline_start: number | null;
  timeline_end: number | null;
  timeline_spans: TimelineSpan[];
  mappable: boolean;
  crossfade_ms: number | null;
  boundary_mode: string | null;
  cut_confidence: number | null;
  review_required: boolean;
  applied: boolean;
  timebase?: string;
  scope?: string;
  /** Why the server cannot render Suggested / A/B (splits, off-timeline edits); null when it can. */
  suggest_reason: string | null;
  join_risk?: PendingJoinRisk | null;
  /** Server-computed (`edits/tighten_hits.is_harsh_tighten_hit`): Avoid harsh cuts skips it. */
  harsh: boolean;
  /** Server-computed (`edits/tighten_hits.is_listen_one_by_one_hit`): Apply suggested actions leaves it pending and names it. */
  listen_one_by_one?: boolean;
  /** Unsure transcript words the cut covers, in word order (`edits/unsure_words.unsure_words_by_edit`); `[]` for a timeline-clock cut. */
  unsure_words?: PendingUnsureWord[];
  /** `unsure_words.length`; a bulk `ApproveEdits` with `skip_unsure` (CLI, MCP, the Review Queue's Cut all) leaves a cut with a non-zero count pending. */
  unsure_count?: number;
  /** Server-computed queue group (`edits/cut_policy.py::review_kind`); the client groups on this, never on `reason`. */
  kind: PendingKind;
  /** Raw detector kind behind `kind` (laugh vs unclear vs possible word); null for `other`. */
  sound_kind?: PendingSoundKind | null;
  /** Plain-words sound kind (`edits/cut_policy.py`); null for non-tighten edits. */
  label?: string | null;
  /** Table default for this kind: cut, shorten, lower or leave. */
  suggested_action?: "cut" | "shorten" | "lower" | "leave" | null;
  /** Plain sentence on why the edit is suggested (`edits/tighten_hits.py`); null for a share guest's suggestion (the guest chooses its reason) and for a reason the server cannot read, so the card omits it; a tighten-shaped reason from an agent plan is shown as written. */
  why?: string | null;
}

export interface AppliedEditRecord {
  id: string;
  applied_at: string;
  operation: string;
  track_ids: string[];
  timeline_start: number | null;
  timeline_end: number | null;
  source_start: number | null;
  source_end: number | null;
  reason: string | null;
  boundary_mode?: string | null;
  crossfade_ms?: number | null;
  cut_confidence?: number | null;
  params: Record<string, unknown>;
}

export interface ChapterMarker {
  time: number;
  title: string;
  image_url?: string | null;
}

export interface SocialClipView {
  id: string;
  track_id: string;
  start: number;
  end: number;
  score: number;
  title_suggestion: string | null;
  approved: boolean;
  review_required: boolean;
}

export interface CommentActionItem {
  id: string;
  text: string;
  done: boolean;
  completed_at: string | null;
  completed_by: string | null;
}

export interface CommentReply {
  id: string;
  body: string;
  author: string;
  created_at: string;
}

export interface TimelineComment {
  timeline_spans?: TimelineSpan[];
  id: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string | null;
  timeline_start: number;
  timeline_end: number | null;
  track_ids: string[];
  action_items: CommentActionItem[];
  replies: CommentReply[];
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  review_version_id?: string | null;
  edit_decision_id?: string | null;
}

export interface AutomationEnvelope {
  track_id: string;
  parameter: string;
  points: AutomationPoint[];
}

export interface AutomationPoint {
  readonly id: string;
  time: number;
  value: number;
}

/** A history entry's id: stable for the life of the entry, unlike its index. */
export type HistoryEntryId = string & { readonly __brand: "HistoryEntryId" };

/**
 * The head of a history with no entry yet. It never names an entry; an undo
 * that saw an empty history sends it, and the server refuses once one exists.
 */
export const HISTORY_ROOT_ID = "root" as HistoryEntryId;

/** Parse a wire value as a history entry id (null when absent or not a non-empty string). */
export function parseHistoryEntryId(value: unknown): HistoryEntryId | null {
  return typeof value === "string" && value !== ""
    ? (value as HistoryEntryId)
    : null;
}

export interface HistoryGroup {
  kind: string;
  label?: string;
  /** Human-readable one-liner (operation + range/tracks when known). */
  title?: string;
  operation?: string | null;
  params?: Record<string, unknown>;
  created_at?: string;
  before_index?: number;
  after_index?: number;
  index?: number;
  /** History entry ids (mutation pairs); from `services/history.py`. */
  before_id?: string;
  after_id?: string;
  /** History entry id (snapshot groups). */
  id?: string;
}

export interface TranscriptTimingTarget {
  track_id: string;
  source_id: string | null;
  word_index: number;
}

/** One unsure word inside a pending cut; `{track_id, source_id, word_index}` is the transcript word's timing target. */
export interface PendingUnsureWord {
  track_id: string;
  source_id: string | null;
  word_index: number;
  text: string;
  confidence: number;
}

export interface TranscriptWordView {
  timing_target?: TranscriptTimingTarget;
  text: string;
  start: number;
  end: number;
  timeline_start?: number | null;
  timeline_end?: number | null;
  mappable?: boolean;
  word_index?: number;
  confidence?: number | null;
  /** Server-computed (`edits/unsure_words.is_unsure_word`): confidence is below `analysis.unsure_word_confidence` (0.7) and the word is not suppressed. Optional only so fixtures and old payloads type-check; the server always sends it. */
  unsure?: boolean;
  suppressed?: boolean;
  /** Struck-through and muted at render, non-destructively (no cut/pending edit, #633). */
  ignored?: boolean;
  /** Own-track audio under the word is digital silence, or the forced aligner found no acoustic evidence (possible Whisper hallucination). */
  suspect_hallucination?: boolean;
  /** A person or agent set `suppressed` directly (not a heuristic pass); reconcile and auto-suppress leave it alone (#768/#781). */
  audibility_locked?: boolean;
}

/**
 * Word fields that a late suppression, ignore, or unlock failure records and reads back
 * with `Boolean()` (transcript/detachedWordFailure.ts). A field drops out of
 * this union once it is no longer `boolean | undefined`, which breaks the
 * build at those call sites instead of quietly merging states.
 */
export type TranscriptWordBooleanFlag = {
  [K in keyof TranscriptWordView]-?: [TranscriptWordView[K]] extends [
    boolean | undefined,
  ]
    ? K
    : never;
}[keyof TranscriptWordView] &
  ("suppressed" | "ignored" | "audibility_locked");

export interface CombinedUtterance {
  track_id: string;
  source_id?: string | null;
  speaker: string;
  start: number;
  end: number;
  text: string;
  timeline_start?: number | null;
  timeline_end?: number | null;
  timeline_spans?: TimelineSpan[];
  mappable?: boolean;
  /** Per-word timings for seek / Edit-mode selection (GUI view). */
  words?: TranscriptWordView[];
  /** Sorted per-track `word_index` of each ignored word in this utterance, only present when non-empty (#633). */
  ignored_word_indices?: number[];
  /** Sorted per-track `word_index` of each edge-suppressed word the mapper attached to this row (outside its own window), only present when non-empty (#752). */
  edge_suppressed_word_indices?: number[];
  /** Sorted indices of locked words, including attached edge words. */
  locked_word_indices?: number[];
  /** View-only row for a track whose words are all suppressed (#758): words[] are those suppressed chips, text their joined text. Not in combined.json. */
  suppressed_only?: boolean;
}

export interface EditBoundaryView {
  id: string;
  track_id: string;
  left_clip_id: string;
  right_clip_id: string | null;
  timeline_join_sec: number;
  cutaway_source_start: number;
  cutaway_source_end: number;
  has_cutaway: boolean;
  cutaway_word_ids: Array<{
    track_id: string;
    source_id: string | null;
    word_index: number;
    text: string;
    start: number;
    end: number;
  }>;
}

export interface ProjectView
  extends Omit<
    GeneratedProjectView,
    | "meta"
    | "tracks"
    | "clips"
    | "chapters"
    | "pending_edits"
    | "edit_boundaries"
    | "applied_edits"
    | "effects_by_track"
    | "envelopes"
    | "social_clips"
    | "comments"
    | "render_status"
    | "edit_impact"
    | "history"
    | "transcript"
  > {
  meta: {
    name: string;
    workspace_dir: string;
    hydration?: {
      transcript_words?: boolean;
      history_groups?: boolean;
    };
  };
  tracks: TrackView[];
  clips: {
    tracks: Record<string, ClipRow[]>;
    clip_count: number;
    timeline_duration_sec?: number;
  };
  chapters: ChapterMarker[];
  pending_edits: PendingEditView[];
  edit_boundaries?: EditBoundaryView[];
  applied_edits: { count: number; records: AppliedEditRecord[] };
  effects_by_track: Record<
    string,
    {
      effect: string;
      params: Record<string, unknown>;
      bypass?: boolean;
      supported?: boolean;
      warning?: string;
    }[]
  >;
  envelopes: AutomationEnvelope[];
  social_clips: SocialClipView[];
  comments: TimelineComment[];
  render_status: {
    needs_rerender: boolean;
    reconciliation: { stale: boolean };
    premix: {
      exists: boolean;
      /** When the premix file was last written (host; guests may lack it). */
      mtime_sec?: number;
      stale_vs_stems?: boolean;
      /** Volume, mute or staging gain changed since the premix was mixed. */
      stale_vs_mix?: boolean;
    };
    invalidations?: Array<{
      id: string;
      track_ids: string[];
      timeline_start: number | null;
      timeline_end: number | null;
      reason: string;
      at: string;
    }>;
    tracks?: Record<
      string,
      {
        stem_is_fresh?: boolean | null;
        stem_exists?: boolean;
        duration_mismatch?: boolean;
        /** What the stem would render from now (edits, clips, FX; not mix). */
        render_hash?: string;
      }
    >;
  };
  edit_impact: {
    pending_review_count: number;
    total_removed_sec: number;
    by_track_sec: Record<string, number>;
  };
  history: {
    cursor: number;
    /** The entry the project holds now; unlike `cursor`, it never names a different entry. */
    head_id: HistoryEntryId;
    can_undo: boolean;
    can_redo: boolean;
    groups: HistoryGroup[];
  };
  transcript: { utterances: CombinedUtterance[] } | null;
}

export type Selection =
  | { kind: "range"; target: ExactRangeTarget }
  /** `ids` holds every selected clip, `id` included, when more than one is selected. */
  | { kind: "clip"; id: string; trackId: string; ids?: readonly string[] }
  | {
      kind: "bleedAttenuation";
      id: string;
      trackId: string;
      regionKey: string | null;
    }
  | { kind: "pending"; id: string; trackId: string }
  /** `trackId` is omitted for a session-wide record (`track_ids: []`). */
  | { kind: "applied"; id: string; trackId?: string }
  /** `trackIds` holds every selected track, `trackId` included, when more than one is selected. */
  | { kind: "track"; trackId: string; trackIds?: readonly string[] }
  | { kind: "chapter"; id: string; time: number }
  | { kind: "social"; id: string }
  | { kind: "comment"; id: string }
  /** Words in one track; a tapped word is a range of one. */
  | {
      kind: "transcriptRange";
      trackId: string;
      sourceId?: string | null;
      startWordIndex: number;
      endWordIndex: number;
    }
  | { kind: "envelope"; trackId: string }
  | { kind: "envelopePoint"; trackId: string; pointId: string }
  | null;

export interface HistoryDiff {
  from_index?: number | null;
  to_index?: number | null;
  from_label?: string;
  to_label?: string;
  operation?: string | null;
  params?: Record<string, unknown>;
  /** Human-readable delta lines from the backend. */
  summary?: string[];
  diff: {
    clips?: { added: unknown[]; removed: unknown[]; changed: unknown[] };
    edit_decisions?: { added: unknown[]; removed: unknown[] };
    edit_log?: { added: unknown[] };
    tracks?: { changed: unknown[] };
    mix_changed?: boolean;
    timeline_duration_sec?: { old?: number | null; new?: number | null };
    meta_changed?: boolean;
  };
}
