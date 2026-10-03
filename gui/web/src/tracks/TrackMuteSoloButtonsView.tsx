import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { ToggleButton } from "../ui/ToggleButton";
import type { MuteState } from "../utils/audio";
import { keepActivationKeys } from "./trackHeaderKeys";
import {
  MUTE_GLYPH,
  muteButtonLabel,
  muteButtonTitle,
  SOLO_GLYPH,
  soloButtonLabel,
  soloButtonTitle,
} from "./trackMuteCopy";

export interface TrackMuteSoloButtonsViewProps {
  trackId: string;
  trackLabel: string;
  muteState: MuteState;
  solo: boolean;
  editsMix: boolean;
  shortcuts?: { mute: string; solo: string };
  onMute: () => void;
  onSolo: () => void;
}

/** Store-free mixer controls shared by the DAW and static previews. */
export function TrackMuteSoloButtonsView({
  trackId,
  trackLabel,
  muteState,
  solo,
  editsMix,
  shortcuts,
  onMute,
  onSolo,
}: TrackMuteSoloButtonsViewProps) {
  const muteClass = {
    saved: " mute",
    listen: " mute mute-listen",
    implied: " mute-implied",
    off: "",
  }[muteState];

  return (
    <>
      <ToggleButton
        pressed={muteState === "saved" || muteState === "listen"}
        aria-disabled={muteState === "saved" && !editsMix ? true : undefined}
        aria-label={muteButtonLabel(trackLabel)}
        className={`trk-btn ui-control--compact${muteClass}`}
        title={muteButtonTitle(muteState, editsMix, shortcuts?.mute)}
        data-mute-state={muteState}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "mute"))}
        onClick={onMute}
        onKeyDown={keepActivationKeys}
      >
        {MUTE_GLYPH}
      </ToggleButton>
      <ToggleButton
        pressed={solo}
        aria-label={soloButtonLabel(trackLabel)}
        className={`trk-btn ui-control--compact${solo ? " solo" : ""}`}
        title={soloButtonTitle(solo, shortcuts?.solo)}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "solo"))}
        onClick={onSolo}
        onKeyDown={keepActivationKeys}
      >
        {SOLO_GLYPH}
      </ToggleButton>
    </>
  );
}
