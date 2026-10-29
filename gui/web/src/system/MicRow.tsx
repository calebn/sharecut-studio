import type { CSSProperties } from "react";
import { Field } from "../ui";
import { JOIN_TEXT, type JoinMic, type JoinNote } from "./joinSheetModel";
import { SystemIcon } from "./SystemIcon";

/**
 * The mic row's control: the input menu when there are two or more inputs,
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
            <select
              {...control}
              className="sys-join-input"
              value={mic.inputId ?? ""}
              disabled={mic.inputLocked}
              onChange={(event) => onInputChange?.(event.target.value)}
            >
              <option value="">{JOIN_TEXT.defaultInput}</option>
              {mic.devices?.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
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
