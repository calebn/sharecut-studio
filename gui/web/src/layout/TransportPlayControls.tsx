import { useId } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { titleWithShortcut } from "../keymap/registry";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { Icon } from "../ui";
import { unavailableReason } from "../ui/disabledReason";

type Props = {
  playing: boolean;
  disabledReason?: string;
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
  disabledReason: rawDisabledReason,
  onTogglePlay,
  onStop,
}: Props) {
  const reasonId = useId();
  const disabledReason = unavailableReason(rawDisabledReason);
  const disabled = disabledReason !== undefined;
  const activatePlay = () => {
    if (!disabled) onTogglePlay();
  };
  const activateStop = () => {
    if (!disabled) onStop();
  };
  return (
    <div className="transport-play">
      <button
        type="button"
        className="ui-control play-btn"
        data-playing={playing}
        title={
          disabledReason ??
          titleWithShortcut(playing ? "Pause" : "Play", "transport.togglePlay")
        }
        aria-label={playing ? "Pause" : "Play"}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={activatePlay}
        {...presenceAnchorProps(presenceAnchor("transport", "play"))}
      >
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <button
        type="button"
        className="ui-control stop-btn"
        // Stop returns the playhead to where playback last started (DAW
        // convention, #533); Pause keeps the position.
        title={titleWithShortcut(
          capabilityTooltip("transport.stop"),
          "transport.stop",
        )}
        aria-label="Stop"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={activateStop}
        {...presenceAnchorProps(presenceAnchor("transport", "stop"))}
      >
        <Icon name="stop" />
      </button>
      {disabledReason !== undefined ? (
        <p id={reasonId} className="transport-play-reason" role="status">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
