import type {
  DamagedSegmentRow,
  SegmentImportPreview,
  SegmentInsertPreview,
  SegmentListRow,
  SegmentRow,
} from "../api";

export function segment(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: "intro-9f3a",
    name: "Cold open",
    kind: "intro",
    version: 1,
    versions: [1],
    clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
    ...over,
  };
}

export const HEALTHY: SegmentRow = segment();

export const MULTI_VERSION: SegmentRow = segment({
  id: "sponsor-21bc",
  name: "Acme sponsor read",
  kind: "sponsor",
  version: 3,
  versions: [1, 2, 3],
  clips: [
    { audio: "a.flac", offset_sec: 0, duration_sec: 20 },
    { audio: "b.flac", offset_sec: 20, duration_sec: 14.6 },
  ],
});

export const MUSIC_BED: SegmentRow = segment({
  id: "bed-5c1d",
  name: "Warm bed",
  kind: "other",
  role: "music",
  duck_under_dialogue: true,
  clips: [{ audio: "bed.flac", offset_sec: 0, duration_sec: 90 }],
});

export const DIALOGUE_READ: SegmentRow = segment({
  id: "read-3e8b",
  name: "Host read",
  kind: "other",
  role: "dialogue",
  clips: [{ audio: "read.flac", offset_sec: 0, duration_sec: 30 }],
});

export const DAMAGED: DamagedSegmentRow = {
  id: "outro-77de",
  version: 2,
  damaged: true,
  problem: "Version 2 has no readable audio: clips/outro.flac is missing.",
  code: "segment_media_invalid",
};

export const LIBRARY: SegmentListRow[] = [HEALTHY, MULTI_VERSION, DAMAGED];

export const PLACEMENT_LIBRARY: SegmentListRow[] = [
  HEALTHY,
  MULTI_VERSION,
  MUSIC_BED,
  DIALOGUE_READ,
  DAMAGED,
];

export const LONG_NAME = segment({
  id: "long-1",
  name: "A very long segment name that keeps going so the row has to wrap under text zoom without a horizontal scrollbar",
  kind: "other",
});

export function insertPreview(
  over: Partial<SegmentInsertPreview> = {},
): SegmentInsertPreview {
  return {
    dry_run: true,
    segment_id: "intro-9f3a",
    segment_version: 1,
    at: 0,
    duration_sec: 22,
    timeline_duration_before_sec: 600,
    timeline_duration_after_sec: 622,
    clips_moved: 4,
    clips_added: 1,
    clips_from_segment: 1,
    chapters_moved: [],
    chapter_added: null,
    comments_moved: [],
    pending_edits_moved: 0,
    tracks_added: [],
    tracks: {},
    ...over,
  };
}

export function waiting(
  over: Partial<SegmentImportPreview> = {},
): SegmentImportPreview {
  return {
    token: "a".repeat(32),
    name: "Cold open",
    kind: "intro",
    duration_sec: 12.4,
    clip_count: 1,
    outcome: "added",
    version: 1,
    existing_id: null,
    ...over,
  };
}

export const SEGMENT_FILE = () =>
  new File(["zip"], "cold-open.sharecutseg", { type: "application/zip" });
