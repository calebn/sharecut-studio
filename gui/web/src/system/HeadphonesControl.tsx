import { useId } from "react";
import { SegmentedControl, ToggleButton } from "../ui";
import {
  type HeadphonesChoice,
  type HeadphonesRule,
  JOIN_TEXT,
  type JoinNote,
} from "./joinSheetModel";
import { SystemIcon } from "./SystemIcon";

function PressedMark() {
  return (
    <SystemIcon name="check" size={16} className="sys-headphones-choice-mark" />
  );
}

/** On `choice` neither button is pressed until the guest answers. */
export function HeadphonesControl({
  rule,
  choice,
  note,
  onChange,
}: {
  rule: HeadphonesRule;
  choice: HeadphonesChoice;
  note: JoinNote | null;
  onChange?: (choice: HeadphonesChoice) => void;
}) {
  const noteId = useId();
  if (rule === "required") {
    const on = choice === "on";
    return (
      <ToggleButton pressed={on} onClick={() => onChange?.(on ? "off" : "on")}>
        <SystemIcon name="headphones" size={16} />
        {JOIN_TEXT.headphones}
      </ToggleButton>
    );
  }
  return (
    <>
      <SegmentedControl
        label={JOIN_TEXT.headphonesGroup}
        className="sys-headphones-choice"
        describedBy={noteId}
      >
        <ToggleButton
          pressed={choice === "on"}
          onClick={() => onChange?.("on")}
        >
          <SystemIcon name="headphones" size={16} />
          {JOIN_TEXT.headphones}
          {choice === "on" ? <PressedMark /> : null}
        </ToggleButton>
        <ToggleButton
          pressed={choice === "off"}
          onClick={() => onChange?.("off")}
        >
          <SystemIcon name="headphone-off" size={16} />
          {JOIN_TEXT.notWearingHeadphones}
          {choice === "off" ? <PressedMark /> : null}
        </ToggleButton>
      </SegmentedControl>
      <div
        id={noteId}
        role="status"
        className="sys-join-notes sys-headphones-note"
      >
        {note ? (
          <p className="sys-join-note">
            <SystemIcon name="triangle-alert" size={16} />
            {note.text}
          </p>
        ) : null}
      </div>
    </>
  );
}
