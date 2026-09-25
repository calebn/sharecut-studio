import type { ClipRow, ProjectView, TrackView } from "../types/project";
import { originTrackId } from "../utils/timebase";
import type { MediaRef, WaveformKind } from "./types";

/**
 * The media a clip draws. FX mode draws the lane's rendered stem while it is
 * fresh; otherwise (and in raw mode) the clip's own file: its pinned
 * `source_id`, else the track its audio comes from.
 */
export function clipMediaRef(
  clip: ClipRow,
  laneTrack: TrackView,
  kind: WaveformKind,
): MediaRef {
  if (kind === "stem" && laneTrack.stem_is_fresh === true) {
    return `stem:${laneTrack.id}`;
  }
  return clip.source_id
    ? `source:${clip.source_id}`
    : `track:${originTrackId(clip)}`;
}

/**
 * Media time (s) at the clip's left edge, preview-aware: `sourceStart` is the
 * clip's live (trim / roll preview) source start. Source media is on the
 * source clock; a stem is rendered on the timeline clock.
 */
export function clipMediaStartSec(
  clip: ClipRow,
  sourceStart: number,
  ref: MediaRef,
): number {
  if (ref.startsWith("stem:")) {
    return clip.timeline_start + (sourceStart - clip.source_start);
  }
  return sourceStart;
}

/**
 * What decides the listed media refs: each track's media and stem freshness,
 * plus the sources clips pin. A change means the status may list new refs.
 */
export function mediaSignature(project: ProjectView | null): string {
  if (!project) {
    return "";
  }
  const tracks = project.tracks.map((t) =>
    [
      t.id,
      t.media_path ?? "",
      t.duration_sec ?? "",
      t.stem_is_fresh ?? "",
    ].join("\u0001"),
  );
  const sources = new Set<string>();
  for (const clips of Object.values(project.clips.tracks)) {
    for (const clip of clips) {
      if (clip.source_id) {
        sources.add(clip.source_id);
      }
    }
  }
  return `${tracks.join("\u0002")}\u0003${[...sources].sort().join("\u0002")}`;
}
