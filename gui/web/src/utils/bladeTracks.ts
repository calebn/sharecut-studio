import type { TrackView } from "../types/project";

type CutTrack = Pick<TrackView, "id" | "label" | "role">;

/** The dialogue tracks, in order: where a blade cut lands when none is selected. */
export function dialogueTrackIds(tracks: readonly CutTrack[]): string[] {
  return tracks.filter((t) => t.role === "dialogue").map((t) => t.id);
}

/** Resolve which tracks a blade cut should target. */
export function bladeTrackIds(
  selectedTrackIds: string[],
  dialogueTrackIds: string[],
): string[] {
  if (selectedTrackIds.length > 0) {
    return selectedTrackIds;
  }
  return dialogueTrackIds;
}

/**
 * What a blade cut will cut, in words: the selected tracks by name, else every
 * dialogue track. The create menu shows it under Blade cut, which sits under a
 * held lane but cuts these tracks.
 */
export function bladeCutNote(
  tracks: readonly CutTrack[],
  selectedTrackIds: string[],
): string {
  if (selectedTrackIds.length === 0) return "Cuts all dialogue tracks";
  const names = selectedTrackIds.map(
    (id) => tracks.find((t) => t.id === id)?.label ?? id,
  );
  return `Cuts ${names.join(", ")}`;
}
