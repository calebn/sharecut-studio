import { useId } from "react";
import { Button } from "../ui";
import { PersonAvatar, type PersonData } from "./Person";
import { SystemIcon } from "./SystemIcon";

export type PickerPerson = PersonData & {
  id: string;
  /** Tells two people with the same name apart: "Track 2, 5:11 of audio". */
  detail?: string;
};

const LABEL = "Who is this voice?";

export type PersonPickerProps = {
  people: readonly PickerPerson[];
  currentId?: string;
  onPick: (id: string) => void;
  onRename?: (id: string) => void;
};

/**
 * One choice among the people in the room. Native radios in labels: the
 * browser owns arrows and the one tab stop, so there is no key handler here.
 * Fix text is a separate button beside the radio, never inside it.
 */
export function PersonPicker({
  people,
  currentId,
  onPick,
  onRename,
}: PersonPickerProps) {
  const group = useId();
  return (
    <div className="sys-picker" role="radiogroup" aria-label={LABEL}>
      <p className="sys-picker-label" aria-hidden="true">
        {LABEL}
      </p>
      {people.map((person) => (
        <div key={person.id} className="sys-picker-row">
          <label className="sys-picker-option">
            <input
              type="radio"
              name={group}
              value={person.id}
              checked={person.id === currentId}
              onChange={() => onPick(person.id)}
            />
            <PersonAvatar person={person} size={24} />
            <span className="sys-picker-text">
              <span className="sys-picker-name">{person.name}</span>
              {person.detail ? (
                <span className="sys-picker-detail">{person.detail}</span>
              ) : null}
            </span>
          </label>
          {onRename ? (
            <Button
              className="sys-picker-fix"
              aria-label={`Fix text for ${person.name}${person.detail ? `, ${person.detail}` : ""}`}
              onClick={() => onRename(person.id)}
            >
              <SystemIcon name="text-cursor-input" size={14} />
              Fix text
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
