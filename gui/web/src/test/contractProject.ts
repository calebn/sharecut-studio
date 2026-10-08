import type { ClipRow, TrackView } from "../types/project";
import { clipRow, sampleTrack } from "./fixtures";

/**
 * The project a `contracts/*.json` trim case describes, as the DAW receives it.
 * `tests/contract_project_helpers.py` builds the same project for the server side.
 */
export interface ContractTrack {
  id: string;
  role: string;
  muted?: boolean;
  /** Defaults to `raw/<id>.wav`. */
  media_path?: string;
  duration_sec?: number | null;
}

export interface ContractSource {
  id: string;
  path: string;
  duration_sec: number | null;
}

/** `[id, timeline_start, source_start, source_end, source_id?]`. */
export type ContractClip = [string, number, number, number, (string | null)?];

export function contractTrack(track: ContractTrack): TrackView {
  return sampleTrack({
    ...track,
    media_path: track.media_path ?? `raw/${track.id}.wav`,
    duration_sec: track.duration_sec ?? null,
  });
}

/**
 * A `list_clips` row: what the clip plays is its source's file and length, or
 * the track's media when it names none (`edits/clips_ops.recording_key`,
 * `source_duration_sec`; `tests/test_list_clips_recording.py` pins them). The key is
 * opaque, so the fixture derives one from the file path: equal files, equal keys.
 */
export function contractClipRow(
  track: ContractTrack,
  sources: readonly ContractSource[],
  [id, timelineStart, sourceStart, sourceEnd, sourceId = null]: ContractClip,
): ClipRow {
  const source = sourceId ? sources.find((s) => s.id === sourceId) : undefined;
  const media = contractTrack(track);
  return clipRow({
    id,
    track_id: track.id,
    source_id: sourceId,
    timeline_start: timelineStart,
    timeline_end: timelineStart + (sourceEnd - sourceStart),
    source_start: sourceStart,
    source_end: sourceEnd,
    source_duration_sec: source ? source.duration_sec : media.duration_sec,
    recording_key: `rec_${source ? source.path : media.media_path}`,
  });
}
