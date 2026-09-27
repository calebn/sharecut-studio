import type { RecordParticipant, RecordSnapshot } from "../record/types";
import type { OfflineConflict, QueuedCommand } from "../state/offlineStore";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type {
  AppliedEditRecord,
  ClipRow,
  ProjectView,
  TimelineComment,
  TrackView,
} from "../types/project";
import type { RenderInvalidationView } from "../utils/staleRender";

/** Minimal ProjectView for unit tests that need DawProvider / store hydrate. */
export function minimalProject(
  overrides: Partial<ProjectView> = {},
): ProjectView {
  return {
    project_path: "/tmp/test/episode.project.json",
    meta: { name: "Test Episode", workspace_dir: "/tmp/test" },
    timeline_duration_sec: 60,
    tracks: [],
    clips: { tracks: {}, clip_count: 0 },
    chapters: [],
    pending_edits: [],
    applied_edits: { count: 0, records: [] },
    effects_by_track: {},
    envelopes: [],
    social_clips: [],
    comments: [],
    render_status: {
      needs_rerender: false,
      reconciliation: { stale: false },
      premix: { exists: false },
    },
    edit_impact: {
      pending_review_count: 0,
      total_removed_sec: 0,
      by_track_sec: {},
    },
    history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
    transcript: null,
    ...overrides,
  };
}

/** A dialogue track with media, a fresh stem and no saved mix changes. */
export function sampleTrack(overrides: Partial<TrackView> = {}): TrackView {
  const id = overrides.id ?? "host";
  return {
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    fader_db: 0,
    muted: false,
    duration_sec: 60,
    media_path: `/tmp/${id}.wav`,
    fx_count: 0,
    stem_is_fresh: true,
    ...overrides,
  };
}

export function sampleComment(
  overrides: Partial<TimelineComment> = {},
): TimelineComment {
  return {
    id: "c1",
    body: "Needs a tighter open",
    author: "caleb",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    timeline_start: 12.5,
    timeline_end: null,
    track_ids: [],
    action_items: [],
    replies: [],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

/** Fictional applied cut for timeline previews and component tests. */
export function appliedEditRecord(
  overrides: Partial<AppliedEditRecord> = {},
): AppliedEditRecord {
  return {
    id: "edit-1",
    applied_at: "2026-01-01T00:00:00Z",
    operation: "remove",
    track_ids: ["mira-voice"],
    timeline_start: 2,
    timeline_end: 3,
    source_start: 2,
    source_end: 3,
    reason: "Shorten the pause",
    params: {},
    ...overrides,
  };
}

/** Fictional offline queue conflict for guest-attention unit tests and stories. */
export function offlineConflict(
  overrides: { command?: Partial<QueuedCommand>; reason?: string } = {},
): OfflineConflict {
  return {
    command: {
      command_id: "sample-command",
      client_seq: 1,
      type: "SetEnvelope",
      payload: {},
      created_at: 0,
      ...overrides.command,
    },
    reason: overrides.reason ?? "Envelope changed since this edit was queued",
  };
}

/** Fictional clip row for timeline unit tests and stories. */
export function clipRow(overrides: Partial<ClipRow> = {}): ClipRow {
  return {
    id: "clip-1",
    track_id: "mira-voice",
    source_start: 0,
    source_end: 10,
    timeline_start: 0,
    timeline_end: 10,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...overrides,
  };
}

/** Fictional stale region for timeline previews and component tests. */
export function renderInvalidation(
  overrides: Partial<RenderInvalidationView> = {},
): RenderInvalidationView {
  return {
    id: "stale-cut",
    track_ids: ["mira-voice"],
    timeline_start: 2,
    timeline_end: 5,
    reason: "cut",
    at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A connected, consented recording participant (defaults to a guest). */
export function recordParticipant(
  overrides: Partial<RecordParticipant> = {},
): RecordParticipant {
  return {
    participant_id: "guest-1",
    role: "guest",
    display_name: "Bo",
    connected: true,
    consented: true,
    muted: false,
    headphones_ack: true,
    ...overrides,
  };
}

/** A recording-room snapshot at the default caps (4 recorded / 2 producers). */
export function recordSnapshot(
  overrides: Partial<RecordSnapshot> = {},
): RecordSnapshot {
  return {
    session_id: "sess-1",
    state: "recording",
    take_index: 0,
    participants: [],
    caps: { recorded: 4, producers: 2 },
    ...overrides,
  };
}

/** Fictional activity for tests and published, prop-only chrome stories. */
export function pipelineJobSnapshot(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "sample-job",
    project_path: "/tmp/sample/episode.project.json",
    from_step: null,
    only_step: null,
    kind: "pipeline",
    status: "running",
    current: 1,
    total: 3,
    message: "Preparing mix preview",
    error: null,
    elapsed_sec: 12,
    steps: [],
    ...overrides,
  };
}
