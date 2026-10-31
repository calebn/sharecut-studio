/** Generated from podcast_mcp/gui/schemas.py — do not edit by hand. Run `make schema-export`. */

export interface BootstrapCancelRequest {
  job_id?: string | null;
}

/** Studio model downloads for Whisper, optional RNNoise, and the opt-in word aligner. */
export interface BootstrapRunRequest {
  components?: Array<string> | null;
  whisper_model?: string | null;
  force?: boolean;
}

export interface BounceRequestBody {
  exact_range?: ExactRangeTarget | null;
  path: string;
  track_ids?: Array<string> | null;
  start_s?: number | null;
  end_s?: number | null;
  formats?: Array<string> | null;
}

export interface Clip {
  id: string;
  track_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  source_id?: string | null;
  fade_in_ms?: number;
  fade_out_ms?: number;
  join_in_mode?: ClipJoinMode;
  mute_regions?: Array<ClipMuteRegion>;
  off_speaker_mute_regions?: Array<ClipOffSpeakerMuteRegion>;
  bleed_restore?: ClipBleedRestore | null;
  timing?: ClipTiming | null;
}

/** Occurrence-owned automatic attenuation choices bound to exact recording bytes. */
export interface ClipBleedRestore {
  source_sha256: string;
  regions: Array<SourceSpan>;
}

/** How an incoming clip meets the previous clip at render time. */
export type ClipJoinMode = "fade" | "crossfade" | "cut";

/** Source-media span muted inside a clip (mute-in-place). Render fades the clip out over the span's first ``fade_out_ms`` and back in over its last ``fade_in_ms`` (an approved tighten mute widens the span by the padded cut's fades, so the cut itself is silent). ``fill`` is the room tone laid under it (``tighten.filler_pad_mode: room_tone``), digital silence when None. A clip cut through the region keeps it whole, so the span may run past the clip's source edges and the clip stays silent up to its cut edge. */
export interface ClipMuteRegion {
  start_s: number;
  end_s: number;
  fill?: RoomToneFill | null;
  fade_out_ms?: number;
  fade_in_ms?: number;
  gain_db?: number | null;
}

/** An automatic SOURCE envelope, independent of ordinary mute and fill ownership. */
export interface ClipOffSpeakerMuteRegion {
  start_s: number;
  end_s: number;
  fade_out_ms?: number;
  fade_in_ms?: number;
}

export interface ClipTiming {
  kind?: "step";
  steps: Array<TimingStep>;
  method?: string;
  evidence?: string | null;
}

export interface CommentActionDoneRequest {
  path: string;
  done?: boolean;
  by: string;
}

export interface CommentCreateRequest {
  path: string;
  body: string;
  author: string;
  timeline_start: number;
  timeline_end?: number | null;
  track_ids?: Array<string>;
  action_texts?: Array<string>;
  edit_decision_id?: string | null;
}

export interface CommentPatchRequest {
  path: string;
  body?: string | null;
  resolved?: boolean | null;
  by?: string | null;
  track_ids?: Array<string> | null;
  timeline_start?: number | null;
  timeline_end?: number | null;
}

export interface CommentReplyRequest {
  path: string;
  body: string;
  author: string;
}

export interface ExactRangeTarget {
  kind?: "exact_range";
  intervals: Array<RangeInterval>;
  track_ids: Array<string>;
  clips: Array<Clip>;
  media_seals: Record<string, string>;
}

export interface ExpectedTimingWord {
  text: string;
  start: number;
  end: number;
}

export interface ExportDeliverablesRequest {
  path: string;
  formats?: Array<Record<string, unknown>> | null;
}

/** One edit to the episode's podcast listing; the empty string unsets. */
export interface FeedEditRequest {
  path: string;
  edit: SetEdit | UnsetEdit;
  by?: "person" | "agent" | "guest";
}

/** One show-level edit from an Editor share; the share link names the episode. */
export interface FeedGuestEditRequest {
  edit: SetEdit | UnsetEdit;
}

/** Write the episode's feed file. */
export interface FeedWriteRequest {
  path: string;
}

/** Whether an Editor share's edit impact read answers as Markdown text instead of fields. */
export interface GuestEditImpactRequest {
  markdown?: boolean;
}

export interface GuestExpectedTimingWord {
  text: string;
  start: number;
  end: number;
}

/** Which deliverables an Editor share exports; each name is a format the host fixes. */
export interface GuestExportRequest {
  formats?: Array<"mp3" | "flac" | "m4a"> | null;
}

/** Which of the share's jobs a guest MCP job tool reads or cancels. */
export interface GuestJobRequest {
  job_id: string;
}

/** Which steps an Editor share starts; the host's working-set config decides the rest. */
export interface GuestPipelineRunRequest {
  from_step?: string | null;
  only_step?: string | null;
  skip_steps?: Array<string> | null;
  force_transcribe?: boolean;
  retime_words?: boolean;
}

/** Mark the transcript checked; the share, not the body, says who did it. */
export interface GuestRefineDoneRequest {
  notes?: string | null;
  expected_fingerprint?: string | null;
}

/** Waive the transcript check; the share, not the body, says who did it. */
export interface GuestRefineWaiveRequest {
  reason: string;
}

/** Preview a find-and-replace on the share's transcript; the search is shorter than the host's. */
export interface GuestReplacementPreviewRequest {
  search: string;
  replacement: string;
  match_case?: boolean;
}

/** Base for the guest request bodies that carry fields of their own: unknown fields are refused. Document commands use their typed payloads instead. */
export type GuestRequest = Record<string, unknown>;

/** Which of the project's social clip candidates an Editor share lists. */
export interface GuestSocialClipsRequest {
  approved?: boolean | null;
  review_required?: boolean | null;
}

/** Move a timeline range between two lanes of one speaker split. */
export interface GuestSpeakerMoveLaneSpanRequest {
  from_lane: string;
  to_lane: string;
  timeline_start: number;
  timeline_end: number;
}

/** Split one of the share's tracks into a lane per speaker; spans are source seconds. */
export interface GuestSpeakerSplitRequest {
  track_id: string;
  speaker_count: number;
  names?: Array<string> | null;
  enrollment?: Record<string, Array<[number, number]>> | null;
}

/** Write or preview the share's transcript files; each name is a format the host fixes. */
export interface GuestTranscriptExportRequest {
  formats?: Array<"txt" | "md" | "srt" | "vtt">;
  dry_run?: boolean;
  with_text?: boolean;
}

/** Save the project's vocabulary from an Editor share; the share names the project. */
export interface GuestVocabularyPutRequest {
  terms: Array<string>;
  guest_names: Array<string>;
  base_revision: string | null;
}

export interface GuestWordTimingContextRequest {
  target: GuestWordTimingTarget;
  expected_word: GuestExpectedTimingWord;
}

export interface GuestWordTimingTarget {
  track_id: string;
  source_id: string | null;
  word_index: number;
}

export interface PipelineAnalyzeRequest {
  path: string;
  apply?: boolean;
}

export interface PipelineCancelRequest {
  job_id?: string | null;
}

export interface PipelineConfigPutRequest {
  path: string;
  config?: Record<string, unknown> | null;
  enabled_steps?: Array<string> | null;
  unattended?: boolean | null;
  reset?: boolean;
}

export interface PipelineRunRequest {
  path: string;
  from_step?: string | null;
  only_step?: string | null;
  skip_steps?: Array<string> | null;
  enabled_steps?: Array<string> | null;
  unattended?: boolean | null;
  config?: Record<string, unknown> | null;
  use_working_set?: boolean;
  force_transcribe?: boolean;
  retime_words?: boolean;
  overwrite_edited?: boolean;
}

export interface ProjectView {
  project_path: string;
  meta: Record<string, unknown>;
  timeline_duration_sec: number;
  tracks: Array<TrackView>;
  clips: Record<string, unknown>;
  chapters: Array<Record<string, unknown>>;
  pending_edits: Array<Record<string, unknown>>;
  session_suggestions?: Array<Record<string, unknown>>;
  edit_boundaries?: Array<Record<string, unknown>>;
  applied_edits: Record<string, unknown>;
  effects_by_track: Record<string, Array<Record<string, unknown>>>;
  envelopes: Array<Record<string, unknown>>;
  social_clips?: Array<Record<string, unknown>>;
  comments?: Array<Record<string, unknown>>;
  render_status: Record<string, unknown>;
  edit_impact: Record<string, unknown>;
  history: Record<string, unknown>;
  transcript?: Record<string, unknown> | null;
}

/** ``[start_s, end_s)`` in source seconds that the solver certified quiet. */
export interface QuietSpan {
  start_s: number;
  end_s: number;
}

export interface RangeInterval {
  start: number;
  end: number;
}

export interface RecordInviteReplaceRequest {
  path: string;
}

export interface RecordRoomCreateRequest {
  path: string;
  expires_at?: string | null;
  target?: Record<string, unknown> | null;
  land_first?: boolean;
}

export interface RecordRoomRevokeRequest {
  path: string;
}

export interface RenderPreviewRequest {
  path: string;
}

/** Room tone tiled under a muted span: this stretch of ``source_id``'s audio. ``source_id`` names a ``sources[]`` entry (a recorded room-tone bed); ``None`` is air sampled from the track's own media. */
export interface RoomToneFill {
  start_s: number;
  end_s: number;
  source_id?: string | null;
}

/** Typed command submit - agent, viewer, and CLI use the same shape. */
export interface SessionCommandRequest {
  client_id: string;
  client_seq: number;
  role?: string;
  type: string;
  payload?: Record<string, unknown>;
  command_id?: string | null;
  causation_id?: string | null;
  label?: string | null;
}

export interface SetEdit {
  op?: "set";
  key: string;
  value: string | number | boolean | Array<string>;
  link?: boolean;
}

/** Guest HTTP twin for MCP guest_set_action_done (no project path). */
export interface ShareActionDoneRequest {
  done?: boolean;
  by?: string;
}

export interface ShareCreateRequest {
  path: string;
  role?: "viewer" | "commenter" | "editor";
  with_mcp?: boolean;
  review_version_id?: string | null;
  freeze?: boolean;
}

export interface ShareRevokeRequest {
  path: string;
}

/** ``[start_s, end_s)`` in source-media seconds. */
export interface SourceSpan {
  start_s: number;
  end_s: number;
}

/** Move a timeline range from one speaker-split lane to a sibling (``SpeakerService``). */
export interface SpeakerMoveLaneSpanRequest {
  path: string;
  from_lane: string;
  to_lane: string;
  timeline_start: number;
  timeline_end: number;
}

/** Studio's Split speakers: the count is the host's, never guessed (``SpeakerService``). */
export interface SpeakerSplitRequest {
  path: string;
  track_id: string;
  speaker_count: number;
  names?: Array<string> | null;
  enrollment?: Record<string, Array<[number, number]>> | null;
}

export interface TimingStep {
  at: number;
  delta_sec: number;
  quiet?: QuietSpan | null;
}

export interface TrackView {
  range_media_seal?: string;
  timeline_empty?: boolean;
  id: string;
  label: string;
  role: string;
  speaker?: string | null;
  gain_db?: number;
  balance_stale?: boolean | null;
  balance_ungated?: boolean | null;
  balance_measured_lufs?: number | null;
  fader_db?: number;
  muted?: boolean;
  duration_sec?: number | null;
  fx_count?: number;
  stem_is_fresh?: boolean | null;
  has_source_audio?: boolean;
  media_path?: string | null;
  speaker_split_id?: string | null;
  fade_max_ms?: number | null;
}

export interface TranscriptExportRequest {
  path: string;
  formats?: Array<string>;
  dry_run?: boolean;
  with_text?: boolean;
}

export interface TranscriptRefineDoneRequest {
  path: string;
  notes?: string | null;
  expected_fingerprint?: string | null;
}

/** The transcript check as the Review stage reads it. */
export interface TranscriptRefineStatusView {
  status: "pending" | "done" | "waived";
  clear: boolean;
  stale: boolean;
  mode: "require" | "waive_unattended" | "off";
  fingerprint: string;
  source?: string | null;
  notes?: string;
  updated_at?: string | null;
  hint?: string | null;
  low_confidence_words: number;
  low_confidence_threshold: number;
}

export interface TranscriptRefineWaiveRequest {
  path: string;
  reason: string;
}

export interface TranscriptReplacementPreviewRequest {
  search: string;
  replacement: string;
  match_case?: boolean;
  path: string;
}

export interface TranscriptVocabularyPutRequest {
  path: string;
  terms: Array<string>;
  guest_names: Array<string>;
  base_revision: string | null;
}

export interface TranscriptWordTimingContextRequest {
  path: string;
  target: WordTimingTargetPayload;
  expected_word: ExpectedTimingWord;
}

export interface UnsetEdit {
  op?: "unset";
  key: string;
}

/** Partial DAW transport snapshot (compat POST → typed commands). */
export interface ViewerSessionSnapshot {
  playhead_sec?: number | null;
  is_playing?: boolean | null;
  audition_mode?: string | null;
  region?: Record<string, unknown> | null;
  source?: string | null;
  track_id?: string | null;
  query?: string | null;
  match_index?: number | null;
  selection?: Record<string, unknown> | null;
  viewer_mute?: Record<string, boolean> | null;
  solo_tracks?: Record<string, boolean> | null;
  tier?: string | null;
  dry_run?: boolean | null;
  wav?: string | null;
  compare_segments?: Array<Record<string, unknown>> | null;
  ack_command_id?: string | null;
  client_id?: string | null;
  label?: string | null;
}

export interface WordTimingTargetPayload {
  track_id: string;
  source_id: string | null;
  word_index: number;
}
