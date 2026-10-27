import { type RefObject, useEffect, useRef, useState } from "react";
import { PersonPicker, type PickerPerson } from "../../system/PersonPicker";
import { Sheet } from "../../system/Sheet";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Dialog } from "../../ui";
import { InlineError } from "../../ui/InlineError";
import { type FixTextAnswer, FixTextField } from "./FixTextField";

type Common = {
  /** The people in the episode. */
  people: readonly PickerPerson[];
  /** The speaker of the turn the popover was opened from. */
  currentId: string;
  /**
   * This turn moves to the person's lane, and the popover closes once the
   * host takes it. A message, or a rejection, keeps it open with the reason.
   */
  onPick: (id: string) => FixTextAnswer;
  /** The person is renamed everywhere. Enter applies; an answer that is a message keeps the field open. */
  onRename: (id: string, name: string) => FixTextAnswer;
  /**
   * The turn moves to a speaker who is not in the episode yet. Left out, the
   * popover offers no "Add speaker" row.
   */
  onAddSpeaker?: (name: string) => FixTextAnswer;
  onClose: () => void;
  /** Start with this person's name already in its field. */
  initialRenamingId?: string;
};

export type SpeakerPopoverProps = Common &
  (
    | {
        /** The desktop card, under the margin name. */
        form?: "anchored";
        /** The margin name that `ScriptPane`'s `onSpeaker` reported. The card sits beside it and focus returns to it. */
        anchorRef: RefObject<HTMLElement | null>;
        open?: boolean;
      }
    | {
        /** The phone sheet. */
        form: "bottom";
        open: boolean;
        anchorRef?: undefined;
      }
  );

const NAME_REQUIRED = "Enter a speaker name.";
const NAME_TAKEN = "Another speaker already has that name.";

/**
 * The speaker popover (spec POP-SPEAKER): the people of the episode with a
 * check on the turn's speaker. Picking another person applies at once, by
 * click, Space or Enter (the arrows only move the focus ring), and closes the
 * popover. The pencil, Fix text, renames the person everywhere: Enter
 * applies, Esc puts the name back, leaving the field changes nothing, and
 * there is no Save button. "Add speaker" takes a new name. Empty and
 * duplicate names are refused with a message. One undo step covers each.
 *
 * Desktop is an anchored `Dialog`: it sits beside the margin name, takes
 * focus on open (on the current speaker), closes on Esc or a press outside,
 * joins the overlay stack so the app keymap holds its keys, and returns focus
 * to the margin name. The phone sheet is the same list in a bottom sheet.
 */
export function SpeakerPopover({
  people,
  currentId,
  onPick,
  onRename,
  onAddSpeaker,
  onClose,
  form,
  anchorRef,
  open = true,
  initialRenamingId,
}: SpeakerPopoverProps) {
  const [renamingId, setRenamingId] = useState(initialRenamingId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);

  useEffect(() => {
    if (!open) return;
    initialFocus.current =
      body.current?.querySelector<HTMLElement>("input.sys-edit-fix") ??
      body.current?.querySelector<HTMLElement>(
        '[role="radio"][tabindex="0"]',
      ) ??
      null;
  }, [open]);
  useEffect(() => {
    if (wasAdding.current && !adding) addButton.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  const nameError = (text: string, except?: string) => {
    if (text === "") return NAME_REQUIRED;
    const taken = people.some(
      (person) =>
        person.id !== except &&
        person.name.trim().toLowerCase() === text.toLowerCase(),
    );
    return taken ? NAME_TAKEN : undefined;
  };
  const settle = async (answer: FixTextAnswer) => {
    try {
      const reason = await answer;
      if (typeof reason === "string" && reason !== "") return reason;
    } catch (failure) {
      return failure instanceof Error && failure.message
        ? failure.message
        : "That did not save. Try again.";
    }
    return undefined;
  };
  const pick = async (id: string) => {
    setError(null);
    const reason = id === currentId ? undefined : await settle(onPick(id));
    if (reason) setError(reason);
    else onClose();
  };
  const addSpeaker = async (name: string) => {
    const reason = await settle(onAddSpeaker?.(name));
    if (!reason) onClose();
    return reason;
  };

  const content = (
    <div ref={body} className="sys-speaker-body">
      <PersonPicker
        apply="activate"
        people={people}
        currentId={currentId}
        onPick={(id) => void pick(id)}
        onRename={setRenamingId}
        renamingId={renamingId}
        renderRename={(person) => (
          <FixTextField
            value={person.name}
            label={`Name for ${person.name}`}
            commitOnBlur={false}
            validate={(text) => nameError(text, person.id)}
            onDone={async (name) => {
              if (name !== null) {
                const reason = await settle(onRename(person.id, name));
                if (reason) return reason;
              }
              setRenamingId(undefined);
            }}
          />
        )}
      />
      {onAddSpeaker ? (
        adding ? (
          <div className="sys-picker-row">
            <div className="sys-picker-option sys-picker-renaming">
              <SystemIcon name="user-plus" size={16} />
              <FixTextField
                value=""
                label="Name of the new speaker"
                commitOnBlur={false}
                validate={(text) => nameError(text)}
                onDone={async (name) => {
                  if (name === null) {
                    setAdding(false);
                    return;
                  }
                  const reason = await addSpeaker(name);
                  if (reason) return reason;
                  setAdding(false);
                }}
              />
            </div>
          </div>
        ) : (
          <Button
            ref={addButton}
            className="sys-picker-add"
            onClick={() => setAdding(true)}
          >
            <SystemIcon name="user-plus" size={14} />
            Add speaker
          </Button>
        )
      ) : null}
      <InlineError message={error} />
    </div>
  );

  if (form === "bottom") {
    return (
      <Sheet form="bottom" title="Speaker" open={open} onClose={onClose}>
        {content}
      </Sheet>
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Speaker"
      panelClassName="sys-speaker-panel"
      initialFocusRef={initialFocus}
      anchor={{
        reason:
          "the card stays beside the margin name it is about, so the turn being moved stays in view",
        ref: anchorRef,
      }}
    >
      {content}
    </Dialog>
  );
}
