import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { ToggleButton } from "../ui";
import type { MuteState } from "../utils/audio";
import {
  muteButtonLabel,
  muteButtonTitle,
  soloButtonLabel,
  soloButtonTitle,
} from "./trackMuteCopy";

export interface TrackMuteSoloButtonsViewProps {
  trackId: string;
  trackLabel: string;
  muteState: MuteState;
  solo: boolean;
  editsMix: boolean;
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
        title={muteButtonTitle(muteState, editsMix)}
        data-mute-state={muteState}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "mute"))}
        onClick={onMute}
      >
        M
      </ToggleButton>
      <ToggleButton
        pressed={solo}
        aria-label={soloButtonLabel(trackLabel)}
        className={`trk-btn ui-control--compact${solo ? " solo" : ""}`}
        title={soloButtonTitle(solo)}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "solo"))}
        onClick={onSolo}
      >
        S
      </ToggleButton>
    </>
  );
}
