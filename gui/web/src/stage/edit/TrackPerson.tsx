import { AddPerson } from "../../stages/edit/AddPerson";
import type { FixTextAnswer } from "../../stages/edit/FixTextField";
import { PersonPicker, type PickerPerson } from "../../system/PersonPicker";
import type { TrackView } from "../../types/project";
import { personId } from "./trackPeople";

const NAME_REQUIRED = "Enter a person's name.";

export function TrackPerson({
  track,
  people,
  onPick,
}: {
  track: TrackView;
  people: readonly PickerPerson[];
  onPick: (speaker: string) => void;
}) {
  const current = personId(track.speaker);
  return people.length > 0 ? (
    <PersonPicker
      apply="activate"
      label="Person"
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
  people,
  onPick,
}: {
  track: TrackView;
  people: readonly PickerPerson[];
  onPick: (speaker: string) => FixTextAnswer;
}) {
  return (
    <AddPerson
      label="Add person"
      fieldLabel="Name of the new person"
      validate={(text) => (text === "" ? NAME_REQUIRED : undefined)}
      onAdd={(name) => {
        const id = personId(name);
        if (id === personId(track.speaker)) return;
        return onPick(people.find((p) => p.id === id)?.name ?? name.trim());
      }}
    />
  );
}
