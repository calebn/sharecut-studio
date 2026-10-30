import { Field } from "../ui";
import { DEVICE_TEXT, type DeviceSheetModel } from "./deviceSheetModel";
import { SystemIcon } from "./SystemIcon";

/**
 * The speaker menu and the notes under it. A pick applies as it changes; the
 * caller routes the room's audio and reports a pick that did not stick.
 */
export function OutputRow({
  output,
  onOutputChange,
}: {
  output: NonNullable<DeviceSheetModel["output"]>;
  onOutputChange?: (outputId: string) => void;
}) {
  return (
    <>
      <Field label="Speaker" className="sys-join-field">
        {(control) => (
          <select
            {...control}
            className="sys-join-input"
            value={output.selectedId}
            onChange={(event) => onOutputChange?.(event.target.value)}
          >
            <option value="">{DEVICE_TEXT.defaultOutput}</option>
            {output.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div role="status" className="sys-join-notes">
        {output.notes.map((note) => (
          <p key={note.text} className="sys-join-note">
            <SystemIcon name="triangle-alert" size={16} />
            {note.text}
          </p>
        ))}
      </div>
    </>
  );
}
