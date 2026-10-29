import { ToggleButton } from "../ui";
import { JOIN_TEXT } from "./joinSheetModel";
import { SystemIcon } from "./SystemIcon";

export function HeadphonesToggle({
  pressed,
  onChange,
}: {
  pressed: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <ToggleButton pressed={pressed} onClick={() => onChange?.(!pressed)}>
      <SystemIcon name="headphones" size={16} />
      {JOIN_TEXT.headphones}
    </ToggleButton>
  );
}
