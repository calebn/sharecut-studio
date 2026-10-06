import { capabilityTooltip } from "../capabilities/copy";
import { useDaw } from "../state/useDaw";
import { CommandButton, pillClassName } from "../ui";
import { anySolo } from "../utils/audio";
import { SOLO_CHIP_ACTION, SOLO_CHIP_STATE } from "./trackMuteCopy";

/**
 * "Solo on · Clear solo": shown while any track is soloed, so a listener who
 * scrolls away or changes screens still sees why other tracks are silent.
 * A narrow track rail stacks state over action and hides the dot visually;
 * the dot stays in the accessible name.
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
      <span>{SOLO_CHIP_STATE}</span> <span className="solo-chip-dot">·</span>{" "}
      <span>{SOLO_CHIP_ACTION}</span>
    </CommandButton>
  );
}
