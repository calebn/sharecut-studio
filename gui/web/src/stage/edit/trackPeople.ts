import { useDawStore } from "../../state/dawStore";
import type { PickerPerson } from "../../system/PersonPicker";
import type { TrackView } from "../../types/project";
import { speakerColorIndex } from "./script/scriptModel";
import { kindOf } from "./trackKind";

export const personId = (speaker: string | null | undefined): string =>
  (speaker ?? "").trim().toLowerCase();

export function episodePeople(
  tracks: readonly TrackView[],
): readonly PickerPerson[] {
  const people = new Map<string, PickerPerson>();
  tracks.forEach((track, position) => {
    const id = personId(track.speaker);
    if (id === "" || kindOf(track.role) !== "voice" || people.has(id)) return;
    people.set(id, {
      id,
      name: (track.speaker ?? "").trim(),
      colorIndex: speakerColorIndex(position),
    });
  });
  return [...people.values()];
}

export function withKnownPeople(
  onTracks: readonly PickerPerson[],
  known: readonly PickerPerson[],
): readonly PickerPerson[] {
  const shown = new Set(onTracks.map((p) => p.id));
  return [...onTracks, ...known.filter((p) => !shown.has(p.id))];
}

/**
 * The people the Person picker lists: those on tracks, plus anyone you
 * switched a track away from before in this project.
 */
export function useEpisodePeople(
  tracks: readonly TrackView[],
): readonly PickerPerson[] {
  const known = useDawStore((s) => s.knownPeople);
  return withKnownPeople(episodePeople(tracks), known);
}
