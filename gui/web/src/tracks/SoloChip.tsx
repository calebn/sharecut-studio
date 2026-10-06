import { capabilityTooltip } from "../capabilities/copy";
import { useDaw } from "../state/useDaw";
import { CommandButton, pillClassName } from "../ui";
import { anySolo } from "../utils/audio";
import { SOLO_CHIP_LABEL } from "./trackMuteCopy";

/**
 * "Solo on · Clear solo": shown while any track is soloed, so a listener who
 * scrolls away or changes screens still sees why other tracks are silent.
 */
export function SoloChip() {
  const on = useDaw((s) => anySolo(s.soloTracks));
  if (!on) {
    return null;
  }
  return (
    <CommandButton
      bare
      commandId="track.clearSolo"
      className={pillClassName("warning", "pill--action", "solo-chip")}
      title={capabilityTooltip("daw.track.clearSolo")}
    >
      {SOLO_CHIP_LABEL}
    </CommandButton>
  );
}
