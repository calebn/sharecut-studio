import { useEffect, useId, useRef } from "react";
import { SegmentedControl, ToggleButton } from "../ui";
import {
  type HeadphonesChoice,
  type HeadphonesRule,
  JOIN_TEXT,
  type JoinNote,
} from "./joinSheetModel";
import { SystemIcon } from "./SystemIcon";

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
  const noteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (choice === "off") {
      noteRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [choice]);
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
          aria-label={JOIN_TEXT.headphones}
          onClick={() => onChange?.("on")}
        >
          <SystemIcon
            name={choice === "on" ? "check" : "headphones"}
            size={16}
          />
          {JOIN_TEXT.wearingShort}
        </ToggleButton>
        <ToggleButton
          pressed={choice === "off"}
          aria-label={JOIN_TEXT.notWearingHeadphones}
          onClick={() => onChange?.("off")}
        >
          <SystemIcon
            name={choice === "off" ? "check" : "headphone-off"}
            size={16}
          />
          {JOIN_TEXT.notWearingShort}
        </ToggleButton>
      </SegmentedControl>
      <div
        ref={noteRef}
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
