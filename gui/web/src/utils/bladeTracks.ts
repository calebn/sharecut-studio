import type { TrackView } from "../types/project";

type CutTrack = Pick<TrackView, "id" | "label" | "role">;

/** The dialogue tracks, in order: where a blade cut lands when none is selected. */
export function dialogueTrackIds(tracks: readonly CutTrack[]): string[] {
  return tracks.filter((t) => t.role === "dialogue").map((t) => t.id);
}

/** Resolve which tracks a blade cut should target. */
export function bladeTrackIds(
  selectedTrackIds: readonly string[],
  dialogueTrackIds: string[],
): string[] {
  if (selectedTrackIds.length > 0) {
    return [...selectedTrackIds];
  }
  return dialogueTrackIds;
}
