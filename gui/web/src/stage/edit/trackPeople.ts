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
