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

function longestSourceSec(tracks: readonly TrackView[]): number {
  return tracks.reduce(
    (longest, t) => Math.max(longest, t.duration_sec ?? 0),
    0,
  );
}

/** Tracks Cut measures: dialogue tracks when any has media, else every track. */
function cutTracks(project: Pick<ProjectView, "tracks">): {
  tracks: readonly TrackView[];
  dialogueOnly: boolean;
} {
  const dialogue = project.tracks.filter((t) => t.role === "dialogue");
  return longestSourceSec(dialogue) > 0
    ? { tracks: dialogue, dialogueOnly: true }
    : { tracks: project.tracks, dialogueOnly: false };
}

/**
 * Longest dialogue-track source media (s), so a music bed or sting longer than
 * the talk does not inflate Cut; every track when no dialogue track has media;
 * 0 when no track has media.
 */
export function projectSourceDurationSec(
  project: Pick<ProjectView, "tracks">,
): number {
  return longestSourceSec(cutTracks(project).tracks);
}

/** Latest clip `timeline_end` on these tracks; null when they have no clips. */
function clipsEndSec(
  tracks: readonly TrackView[],
  clips: ProjectView["clips"],
): number | null {
  let end: number | null = null;
  for (const t of tracks) {
    for (const c of clips.tracks[t.id] ?? []) {
      end = Math.max(end ?? 0, c.timeline_end);
    }
  }
  return end;
}

export type TimelineCut = {
  cutSec: number;
  sourceSec: number;
  timelineSec: number;
};

/**
 * Source audio cut from the timeline by every edit kind (remove decisions,
 * ripple, trim, structural), as source length minus timeline length. Both
 * sides use the same tracks: with dialogue media, the latest dialogue clip end
 * (an uncut music bed past it does not hide the cut); otherwise, or when those
 * tracks have no clips, `timeline_duration_sec`. Net of those tracks: gaps or
 * clips moved past the source end offset it. Null without source media.
 */
export function timelineCut(
  project: Pick<ProjectView, "tracks" | "clips" | "timeline_duration_sec">,
): TimelineCut | null {
  const { tracks, dialogueOnly } = cutTracks(project);
  const sourceSec = longestSourceSec(tracks);
  if (!(sourceSec > 0)) {
    return null;
  }
  const dialogueEnd = dialogueOnly ? clipsEndSec(tracks, project.clips) : null;
  const timelineSec = Math.max(
    0,
    dialogueEnd ?? (project.timeline_duration_sec || 0),
  );
  return {
    cutSec: Math.max(0, sourceSec - timelineSec),
    sourceSec,
    timelineSec,
  };
}
