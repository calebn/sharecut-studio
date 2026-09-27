import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { ToggleButton } from "../ui";
import type { MuteState } from "../utils/audio";
import { SAVED_MUTE_READ_ONLY } from "./trackMuteCopy";

export interface TrackMuteSoloButtonsViewProps {
  trackId: string;
  muteState: MuteState;
  solo: boolean;
  editsMix: boolean;
  onMute: () => void;
  onSolo: () => void;
}

/** Store-free mixer controls shared by the DAW and static previews. */
export function TrackMuteSoloButtonsView({
  trackId,
  muteState,
  solo,
  editsMix,
  onMute,
  onSolo,
}: TrackMuteSoloButtonsViewProps) {
  const muteTitle: Record<MuteState, string> = {
    saved: editsMix
      ? "Muted in the mix, for everyone and every export"
      : SAVED_MUTE_READ_ONLY,
    listen: "Muted for you only",
    implied: "Silenced by your solo",
    off: editsMix ? "Mute in the mix" : "Mute for you only",
  };
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
        className={`trk-btn ui-control--compact${muteClass}`}
        title={muteTitle[muteState]}
        data-mute-state={muteState}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "mute"))}
        onClick={onMute}
      >
        M
      </ToggleButton>
      <ToggleButton
        pressed={solo}
        className={`trk-btn ui-control--compact${solo ? " solo" : ""}`}
        title={solo ? "Soloed for you only" : "Solo for you only"}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "solo"))}
        onClick={onSolo}
      >
        S
      </ToggleButton>
    </>
  );
}
