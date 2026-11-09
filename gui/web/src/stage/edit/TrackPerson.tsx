import { AddPerson } from "../../stages/edit/AddPerson";
import { PersonPicker } from "../../system/PersonPicker";
import type { TrackView } from "../../types/project";
import { episodePeople, personId } from "./trackPeople";

const NAME_REQUIRED = "Enter a person's name.";

export function TrackPerson({
  track,
  tracks,
  onPick,
}: {
  track: TrackView;
  tracks: readonly TrackView[];
  onPick: (speaker: string) => void;
}) {
  const people = episodePeople(tracks);
  const current = personId(track.speaker);
  return people.length > 0 ? (
    <PersonPicker
      apply="activate"
      people={people}
      currentId={current === "" ? undefined : current}
      onPick={(id) => {
        const person = people.find((p) => p.id === id);
        if (person && id !== current) onPick(person.name);
      }}
    />
  ) : null;
}

export function AddTrackPerson({
  track,
  tracks,
  onPick,
}: {
  track: TrackView;
  tracks: readonly TrackView[];
  onPick: (speaker: string) => void;
}) {
  const people = episodePeople(tracks);
  return (
    <AddPerson
      label="Add person"
      fieldLabel="Name of the new person"
      validate={(text) => (text === "" ? NAME_REQUIRED : undefined)}
      onAdd={(name) => {
        const id = personId(name);
        if (id === personId(track.speaker)) return;
        onPick(people.find((p) => p.id === id)?.name ?? name.trim());
      }}
    />
  );
}
