import type { ProjectView, TimelineComment } from "../types/project";

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
    peaks_index: {},
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
