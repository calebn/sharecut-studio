import { type CSSProperties, useState } from "react";
import { Button, Field, Menu, MenuItem } from "../ui";
import type { FieldControlProps } from "../ui/Field";
import {
  JOIN_TEXT,
  type JoinInput,
  type JoinMic,
  type JoinNote,
} from "./joinSheetModel";
import { SystemIcon } from "./SystemIcon";

function InputMenu({
  control,
  devices,
  inputId,
  locked,
  onInputChange,
}: {
  control: FieldControlProps;
  devices: JoinInput[];
  inputId: string;
  locked?: boolean;
  onInputChange?: (inputId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = devices.some((device) => device.id === inputId) ? inputId : "";
  const current =
    devices.find((device) => device.id === picked)?.label ??
    JOIN_TEXT.defaultInput;
  const choices = [{ id: "", label: JOIN_TEXT.defaultInput }, ...devices];
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Input"
      className="ui-menu-root sys-mic-input-root"
      trigger={(props) => (
        <Button
          {...props}
          {...control}
          className="sys-mic-input"
          aria-label={`Input: ${current}`}
          disabledReason={locked ? JOIN_TEXT.inputLocked : undefined}
        >
          <span className="sys-mic-input-name">{current}</span>
          <SystemIcon name="chevron-down" size={14} />
        </Button>
      )}
    >
      {choices.map((choice) => (
        <MenuItem
          key={choice.id}
          checked={choice.id === picked}
          onSelect={() => {
            setOpen(false);
            onInputChange?.(choice.id);
          }}
        >
          {choice.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

/**
 * The mic row's control: the input chip that opens the input menu,
 * the level meter with its clip tick, and the notes under it. Shared by the
 * Join sheet and the Device sheet.
 */
export function MicRow({
  mic,
  notes,
  onInputChange,
}: {
  mic: JoinMic;
  notes: JoinNote[];
  onInputChange?: (inputId: string) => void;
}) {
  return (
    <>
      {(mic.status === "ready" || mic.status === "lost") &&
      mic.devices?.length ? (
        <Field
          label="Input"
          hint={mic.inputLocked ? JOIN_TEXT.inputLocked : undefined}
          className="sys-join-field"
        >
          {(control) => (
            <InputMenu
              control={control}
              devices={mic.devices ?? []}
              inputId={mic.inputId ?? ""}
              locked={mic.inputLocked}
              onInputChange={onInputChange}
            />
          )}
        </Field>
      ) : null}
      {mic.status === "ready" ? (
        <span className="sys-room-meter sys-join-meter" aria-hidden="true">
          <span
            className="sys-room-meter-fill"
            style={{ "--sys-room-level": mic.level } as CSSProperties}
          />
          <span
            className="sys-join-clip"
            data-lit={mic.clipped ? "" : undefined}
          />
        </span>
      ) : null}
      <div role="status" className="sys-join-notes">
        {notes.map((note) => (
          <p key={note.text} className="sys-join-note">
            <SystemIcon name="triangle-alert" size={16} />
            {note.text}
          </p>
        ))}
      </div>
    </>
  );
}
