import { useId } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { titleWithShortcut } from "../keymap/registry";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import type { TransportAvailability } from "../state/transportAvailability";
import { Icon } from "../ui";
import { unavailableReason } from "../ui/disabledReason";

type Props = {
  playing: boolean;
  availability: TransportAvailability;
  onTogglePlay: () => void;
  onStop: () => void;
};

/**
 * Play/Pause and Stop, shared by the transport strip and the phone Listen
 * card. Presentational: the live shells pass `transportPlayHandlers` (the
 * same `transport.*` commands the keyboard runs); stories pass local state.
 */
export function TransportPlayControls({
  playing,
  availability,
  onTogglePlay,
  onStop,
}: Props) {
  const reasonId = useId();
  const playReason = unavailableReason(availability.togglePlay);
  const stopReason = unavailableReason(availability.stop);
  const playReasonId = `${reasonId}-play`;
  const stopReasonId =
    stopReason === playReason ? playReasonId : `${reasonId}-stop`;
  const activatePlay = () => {
    if (playReason === undefined) onTogglePlay();
  };
  const activateStop = () => {
    if (stopReason === undefined) onStop();
  };
  return (
    <div className="transport-play">
      <button
        type="button"
        className="ui-control play-btn"
        data-playing={playing}
        title={
          playReason ??
          titleWithShortcut(playing ? "Pause" : "Play", "transport.togglePlay")
        }
        aria-label={playing ? "Pause" : "Play"}
        aria-disabled={playReason !== undefined || undefined}
        aria-describedby={playReason !== undefined ? playReasonId : undefined}
        onClick={activatePlay}
        {...presenceAnchorProps(presenceAnchor("transport", "play"))}
      >
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <button
        type="button"
        className="ui-control stop-btn"
        title={
          stopReason ??
          titleWithShortcut(
            capabilityTooltip("transport.stop"),
            "transport.stop",
          )
        }
        aria-label="Stop"
        aria-disabled={stopReason !== undefined || undefined}
        aria-describedby={stopReason !== undefined ? stopReasonId : undefined}
        onClick={activateStop}
        {...presenceAnchorProps(presenceAnchor("transport", "stop"))}
      >
        <Icon name="stop" />
      </button>
      {playReason !== undefined ? (
        <p id={playReasonId} className="transport-play-reason" role="status">
          {playReason}
        </p>
      ) : null}
      {stopReason !== undefined && stopReason !== playReason ? (
        <p id={stopReasonId} className="transport-play-reason" role="status">
          {stopReason}
        </p>
      ) : null}
    </div>
  );
}
