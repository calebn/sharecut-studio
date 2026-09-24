import { displayShortcutFor } from "../keymap/registry";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { Icon } from "../ui";

type Props = {
  playing: boolean;
  /** Nothing to play yet: no project loaded, or a project with no tracks. */
  disabled?: boolean;
  /** Play's tooltip while disabled (e.g. "Import audio to play"). */
  disabledTitle?: string;
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
  disabled = false,
  disabledTitle,
  onTogglePlay,
  onStop,
}: Props) {
  const playKey = displayShortcutFor("transport.togglePlay");
  const stopKey = displayShortcutFor("transport.stop");
  const withKey = (label: string, key: string | undefined) =>
    key ? `${label} (${key})` : label;
  return (
    <>
      <button
        type="button"
        className="ui-control play-btn"
        data-playing={playing}
        title={
          disabled
            ? disabledTitle
            : withKey(playing ? "Pause" : "Play", playKey)
        }
        aria-label={playing ? "Pause" : "Play"}
        disabled={disabled}
        onClick={onTogglePlay}
        {...presenceAnchorProps(presenceAnchor("transport", "play"))}
      >
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <button
        type="button"
        className="ui-control stop-btn"
        // Stop halts in place (K in the J/K/L convention, and MCP's stop
        // tool); it never promised a return to the start.
        title={withKey("Stop", stopKey)}
        aria-label="Stop"
        disabled={disabled}
        onClick={onStop}
        {...presenceAnchorProps(presenceAnchor("transport", "stop"))}
      >
        <Icon name="stop" />
      </button>
    </>
  );
}
