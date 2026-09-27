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

/** A timeline lane may also contain clips sourced from another track. */
export function trackHasAudioContent(
  track: TrackView,
  project: Pick<ProjectView, "clips">,
): boolean {
  return (
    trackHasSourceAudio(track) ||
    (project.clips.tracks[track.id]?.length ?? 0) > 0
  );
}

export function projectHasSourceAudio(
  project: Pick<ProjectView, "tracks" | "clips">,
): boolean {
  return (
    project.clips.clip_count > 0 || project.tracks.some(trackHasSourceAudio)
  );
}

/** Longest track source media (s); 0 when no track has media. */
export function projectSourceDurationSec(
  project: Pick<ProjectView, "tracks">,
): number {
  return project.tracks.reduce(
    (longest, t) => Math.max(longest, t.duration_sec ?? 0),
    0,
  );
}

export type TimelineCut = {
  cutSec: number;
  sourceSec: number;
  timelineSec: number;
};

/**
 * Source audio cut from the timeline by every edit kind (remove decisions,
 * ripple, trim, structural), as source length minus timeline length.
 * Null without source media.
 */
export function timelineCut(
  project: Pick<ProjectView, "tracks" | "timeline_duration_sec">,
): TimelineCut | null {
  const sourceSec = projectSourceDurationSec(project);
  if (!(sourceSec > 0)) {
    return null;
  }
  const timelineSec = Math.max(0, project.timeline_duration_sec || 0);
  return {
    cutSec: Math.max(0, sourceSec - timelineSec),
    sourceSec,
    timelineSec,
  };
}
