import { Field } from "../ui";
import { DEVICE_TEXT, type DeviceSheetModel } from "./deviceSheetModel";

/**
 * The speaker menu, with its note as the field's hint. A pick applies as it
 * changes; the caller routes the room's audio and reports a pick that did not
 * stick, which is announced when it appears.
 */
export function OutputRow({
  output,
  onOutputChange,
}: {
  output: NonNullable<DeviceSheetModel["output"]>;
  onOutputChange?: (outputId: string) => void;
}) {
  return (
    <Field
      label={DEVICE_TEXT.speaker}
      hint={output.notes.map((note) => note.text).join(" ") || undefined}
      hintLive
      className="sys-join-field"
    >
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
  );
}
