import type { ClipRow, TrackView } from "../types/project";
import { capitalize } from "./format";
import { formatDurationLabel, formatTime } from "./time";

export function clipIdentityTrack({
  clip,
  tracks,
}: {
  clip: Pick<ClipRow, "origin_track_id" | "track_id">;
  tracks: readonly TrackView[];
}): TrackView | undefined {
  return (
    tracks.find((track) => track.id === clip.origin_track_id) ??
    tracks.find((track) => track.id === clip.track_id)
  );
}

type ClipSpeakerIdentity = {
  trackSpeaker?: string | null;
  trackLabel?: string | null;
  role: string;
};

export function clipSpeakerLabel({
  trackSpeaker,
  trackLabel,
  role,
}: ClipSpeakerIdentity): string {
  return (
    trackSpeaker?.trim() ||
    trackLabel?.trim() ||
    capitalize(role.trim()) ||
    "Audio"
  );
}

export function clipLabels({
  clip,
  trackSpeaker,
  trackLabel,
  role,
}: {
  clip: Pick<
    ClipRow,
    "source_start" | "source_end" | "timeline_start" | "timeline_end"
  >;
} & ClipSpeakerIdentity) {
  const speaker = clipSpeakerLabel({ trackSpeaker, trackLabel, role });
  const start = formatTime(clip.timeline_start);
  const end = formatTime(clip.timeline_end);
  const duration = formatDurationLabel(clip.source_end - clip.source_start);
  return {
    speaker,
    start,
    end,
    duration,
    select: `Select ${speaker} clip at ${start}, ${duration}`,
    heading: `${speaker} clip, ${start} to ${end}`,
  };
}
