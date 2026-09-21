import type { ProjectView, TrackView } from "../types/project";

/** Guest shares redact media_path but retain source presence and duration. */
export function trackHasSourceAudio(
  track: Pick<TrackView, "has_source_audio" | "media_path" | "duration_sec">,
): boolean {
  return (
    track.has_source_audio === true ||
    Boolean(track.media_path) ||
    (track.duration_sec ?? 0) > 0
  );
}

export function projectHasSourceAudio(
  project: Pick<ProjectView, "tracks" | "clips">,
): boolean {
  return (
    project.clips.clip_count > 0 || project.tracks.some(trackHasSourceAudio)
  );
}
