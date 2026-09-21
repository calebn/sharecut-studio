export interface TimelineSpan {
  start: number;
  end: number;
}

export interface ClipMuteRegion {
  start_s: number;
  end_s: number;
}

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
  source_id: string | null;
  origin_track_id?: string | null;
  mute_regions?: ClipMuteRegion[];
}

export interface TrackView {
  id: string;
  label: string;
  role: string;
  speaker: string | null;
  gain_db: number;
  muted: boolean;
  duration_sec: number | null;
  fx_count: number;
  stem_is_fresh: boolean | null;
  has_source_audio?: boolean;
  media_path?: string | null;
}

export interface PendingJoinRisk {
  verdict: "pass" | "review" | "fail";
  label?: string | null;
  source?: string;
  risk?: number | null;
}

export interface PendingEditView {
  id: string;
  track_id: string;
  track_ids?: string[];
  type: string;
  reason: string | null;
  source_start: number;
  source_end: number;
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
  can_skip?: boolean;
  skip_reason?: string | null;
  join_risk?: PendingJoinRisk | null;
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
  points: { time: number; value: number }[];
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
}

export interface TranscriptWordView {
  text: string;
  start: number;
  end: number;
  timeline_start?: number | null;
  timeline_end?: number | null;
  mappable?: boolean;
  word_index?: number;
  confidence?: number | null;
  suppressed?: boolean;
}

export interface CombinedUtterance {
  track_id: string;
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
    word_index: number;
    text: string;
    start: number;
    end: number;
  }>;
}

export interface ProjectView {
  project_path: string;
  meta: {
    name: string;
    workspace_dir: string;
    hydration?: {
      transcript_words?: boolean;
      history_groups?: boolean;
    };
  };
  timeline_duration_sec: number;
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
    { effect: string; params: Record<string, unknown>; bypass?: boolean }[]
  >;
  envelopes: AutomationEnvelope[];
  social_clips: SocialClipView[];
  comments: TimelineComment[];
  render_status: {
    needs_rerender: boolean;
    reconciliation: { stale: boolean };
    premix: { exists: boolean; stale_vs_stems?: boolean };
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
    can_undo: boolean;
    can_redo: boolean;
    groups: HistoryGroup[];
  };
  transcript: { utterances: CombinedUtterance[] } | null;
  peaks_index: Record<string, boolean>;
}

export type Selection =
  | { kind: "clip"; id: string; trackId: string }
  | { kind: "pending"; id: string; trackId: string }
  | { kind: "applied"; id: string; trackId: string }
  | { kind: "track"; trackId: string }
  | { kind: "chapter"; id: string; time: number }
  | { kind: "social"; id: string }
  | { kind: "comment"; id: string }
  | { kind: "transcriptWord"; trackId: string; wordIndex: number }
  | {
      kind: "transcriptRange";
      trackId: string;
      startWordIndex: number;
      endWordIndex: number;
    }
  | { kind: "envelopePoint"; trackId: string; index: number }
  | null;

export interface PeaksData {
  peaks: number[] | Uint8Array;
  samples_per_pixel: number;
  sample_rate: number;
  bins_per_sec?: number;
  encoding?: string;
  duration_sec?: number;
}

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
