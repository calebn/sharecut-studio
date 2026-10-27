import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
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
  /**
   * The person being renamed. Their row shows `renderRename`'s field in place
   * of the radio, and focus goes back to their Fix text button when it closes.
   */
  renamingId?: string;
  renderRename?: (person: PickerPerson) => ReactNode;
  /**
   * When a press picks. `change` (default) is a native radio group: arrows
   * pick, as in the Record card. `activate` is for a pick that applies at
   * once and may close the picker: the arrows only move the focus ring, and
   * click, Space or Enter picks.
   */
  apply?: "change" | "activate";
};

const MOVES: Record<string, -1 | 1 | "first" | "last"> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

/**
 * One choice among the people in the room. In `change` mode these are native
 * radios in labels: the browser owns arrows and the one tab stop, so there is
 * no key handler. In `activate` mode they are `role="radio"` buttons with a
 * roving tab stop, because a native radio picks on every arrow. Fix text is a
 * separate button beside the choice, never inside it.
 */
export function PersonPicker({
  people,
  currentId,
  onPick,
  onRename,
  renamingId,
  renderRename,
  apply = "change",
}: PersonPickerProps) {
  const group = useId();
  const fixButtons = useRef(new Map<string, HTMLButtonElement>());
  const choices = useRef(new Map<string, HTMLButtonElement>());
  const tabStop =
    people.find((person) => person.id === currentId)?.id ?? people[0]?.id;
  const moveRing = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const move = MOVES[event.key];
    if (move === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const at = people.findIndex((person) => person.id === id);
    const to =
      move === "first"
        ? 0
        : move === "last"
          ? people.length - 1
          : (at + move + people.length) % people.length;
    choices.current.get(people[to].id)?.focus();
  };
  const wasRenaming = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = wasRenaming.current;
    wasRenaming.current = renamingId;
    if (was !== undefined && renamingId === undefined) {
      fixButtons.current.get(was)?.focus();
    }
  }, [renamingId]);
  return (
    <div className="sys-picker" role="radiogroup" aria-label={LABEL}>
      <p className="sys-picker-label" aria-hidden="true">
        {LABEL}
      </p>
      {people.map((person) =>
        renamingId === person.id && renderRename ? (
          <div key={person.id} className="sys-picker-row">
            <div className="sys-picker-option sys-picker-renaming">
              <PersonAvatar person={person} size={24} />
              {renderRename(person)}
            </div>
          </div>
        ) : (
          <div key={person.id} className="sys-picker-row">
            {apply === "activate" ? (
              <button
                type="button"
                role="radio"
                aria-checked={person.id === currentId}
                ref={(el) => {
                  if (el) choices.current.set(person.id, el);
                  else choices.current.delete(person.id);
                }}
                className="sys-picker-option"
                data-checked={person.id === currentId ? "" : undefined}
                tabIndex={person.id === tabStop ? 0 : -1}
                onClick={() => onPick(person.id)}
                onKeyDown={(event) => moveRing(event, person.id)}
              >
                <span className="sys-picker-mark" aria-hidden="true">
                  {person.id === currentId ? (
                    <SystemIcon name="check" size={14} />
                  ) : null}
                </span>
                <PersonAvatar person={person} size={24} />
                <span className="sys-picker-text">
                  <span className="sys-picker-name">{person.name}</span>
                  {person.detail ? (
                    <span className="sys-picker-detail">{person.detail}</span>
                  ) : null}
                </span>
              </button>
            ) : (
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
            )}
            {onRename ? (
              <Button
                ref={(el) => {
                  if (el) fixButtons.current.set(person.id, el);
                  else fixButtons.current.delete(person.id);
                }}
                className="sys-picker-fix"
                aria-label={`Fix text, rename ${person.name} everywhere${person.detail ? `, ${person.detail}` : ""}`}
                onClick={() => onRename(person.id)}
              >
                <SystemIcon name="text-cursor-input" size={14} />
                Fix text
              </Button>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}
