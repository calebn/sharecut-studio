import { useState } from "react";
import type { HistoryButtonsProps } from "../../system/HistoryButtons";
import { Player } from "../../system/Player";
import { RECONNECT_FOR_SAVED_AUDIO } from "../../utils/audioErrorLabel";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./useFrameAlert";
import { usePlayerProps } from "./usePlayerProps";

/**
 * The Player on every stage but Record. The bar form on a phone expands on a
 * tap of the time into a Sheet-height card with the chapters; the `dock`
 * placement (phone guest Review) never expands.
 */
export function PlayerBar({
  placement = "bar",
  history,
}: {
  placement?: "bar" | "dock";
  history?: HistoryButtonsProps;
}) {
  const [expanded, setExpanded] = useState(false);
  const form = placement === "dock" ? "dock" : expanded ? "expanded" : "bar";
  const props = usePlayerProps(form, (next) =>
    setExpanded(next === "expanded"),
  );
  const recovery = props.errorLabel === RECONNECT_FOR_SAVED_AUDIO;
  useFrameAlert(
    FRAME_ALERT_PRIORITY.needsYou,
    recovery && props.onRetry
      ? {
          state: "needs-you",
          title: RECONNECT_FOR_SAVED_AUDIO,
          action: {
            label: "Retry",
            name: "Retry audio",
            onAction: props.onRetry,
          },
        }
      : null,
  );
  return (
    <Player
      {...props}
      state={recovery ? "ready" : props.state}
      history={history}
    />
  );
}
