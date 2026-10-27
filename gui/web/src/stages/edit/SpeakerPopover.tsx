import { useState } from "react";
import { PersonPicker, type PickerPerson } from "../../system/PersonPicker";
import { Sheet } from "../../system/Sheet";
import { FixTextField } from "./FixTextField";

export type SpeakerPopoverProps = {
  /** The people in the episode. */
  people: readonly PickerPerson[];
  /** The speaker of the turn the popover was opened from. */
  currentId: string;
  /** This turn moves to the person's lane. Applies as soon as it is picked. */
  onPick: (id: string) => void;
  /** The person is renamed everywhere. Applies on Enter, with the new name. */
  onRename: (id: string, name: string) => void;
  onClose: () => void;
  /** `anchored` is the desktop card under the margin name; `bottom` is the phone sheet. */
  form?: "anchored" | "bottom";
  /** Phone sheet only. */
  open?: boolean;
  /** Start with this person's name already in its field. */
  initialRenamingId?: string;
};

/**
 * The speaker popover (spec POP-SPEAKER): the people of the episode with a
 * check on the turn's speaker, in a Sheet. Picking another person applies at
 * once and the pencil, Fix text, renames the person: Enter applies, Esc puts
 * the name back, and there is no Save button. One undo step covers either.
 *
 * The popover does not position itself or close itself. The host anchors it
 * to the margin name that `ScriptPane`'s `onSpeaker` reports, and closes it
 * (with Esc through the anchored-panel hook) when the pick is made.
 */
export function SpeakerPopover({
  people,
  currentId,
  onPick,
  onRename,
  onClose,
  form = "anchored",
  open,
  initialRenamingId,
}: SpeakerPopoverProps) {
  const [renamingId, setRenamingId] = useState(initialRenamingId);
  return (
    <Sheet
      form={form}
      title="Speaker"
      icon="user"
      open={open}
      onClose={onClose}
    >
      <PersonPicker
        people={people}
        currentId={currentId}
        onPick={onPick}
        onRename={setRenamingId}
        renamingId={renamingId}
        renderRename={(person) => (
          <FixTextField
            value={person.name}
            label={`Name for ${person.name}`}
            onDone={(name) => {
              setRenamingId(undefined);
              if (name !== null) onRename(person.id, name);
            }}
          />
        )}
      />
    </Sheet>
  );
}
