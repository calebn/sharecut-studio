import { type CSSProperties, useEffect, useState } from "react";
import { Button, Field, Menu, MenuItem } from "../ui";
import type { FieldControlProps } from "../ui/Field";
import {
  JOIN_TEXT,
  type JoinInput,
  type JoinMic,
  type JoinNote,
  type JoinRow,
  MIC_ROW_TITLE,
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
  // An empty input id means Default, so a device whose id is "" never matches.
  const picked = inputId
    ? devices.find((device) => device.id === inputId)
    : undefined;
  const current = picked?.label ?? JOIN_TEXT.defaultInput;
  const choices = [
    { id: "", label: JOIN_TEXT.defaultInput, isDefault: true },
    ...devices.map((device) => ({ ...device, isDefault: false })),
  ];
  // A take starting while the menu is open must not leave live rows behind.
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
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
          key={choice.isDefault ? "default" : `device:${choice.id}`}
          checked={
            picked
              ? !choice.isDefault && choice.id === picked.id
              : choice.isDefault
          }
          onSelect={() => {
            setOpen(false);
            if (locked) return;
            onInputChange?.(choice.id);
          }}
        >
          {choice.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

function micStatusLine(row: JoinRow): string {
  if (row.state === "running") return row.detail ?? "";
  if (row.state === "needs-you" && row.title === MIC_ROW_TITLE) {
    return row.detail ?? "";
  }
  if (row.state === "needs-you" || row.state === "failed") {
    return [row.title, row.detail]
      .filter((part): part is string => Boolean(part))
      .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
      .join(" ");
  }
  return "";
}

export function MicStatus({ row }: { row?: JoinRow }) {
  return (
    <p className="sr-only" role="status">
      {row ? micStatusLine(row) : ""}
    </p>
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
