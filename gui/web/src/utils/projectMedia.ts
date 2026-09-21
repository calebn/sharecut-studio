import type { ProjectView, TrackView } from "../types/project";

/** Guest shares redact media_path but retain the source's duration. */
export function trackHasSourceAudio(
  track: Pick<TrackView, "media_path" | "duration_sec">,
): boolean {
  return Boolean(track.media_path) || (track.duration_sec ?? 0) > 0;
}

export function projectHasSourceAudio(
  project: Pick<ProjectView, "tracks">,
): boolean {
  return project.tracks.some(trackHasSourceAudio);
}
