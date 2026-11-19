import { playSpan } from "../commands/playSpan";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import {
  InspectorSeekFooterView,
  type InspectorSeekFooterViewProps,
} from "./InspectorSeekFooterView";

type Props = Omit<
  InspectorSeekFooterViewProps,
  | "onSeek"
  | "onPlay"
  | "previewMode"
  | "onPreviewModeChange"
  | "suggestDisabledReason"
> & {
  seekSec: number;
  playStart: number;
  playEnd: number;
  padSec?: number;
};

/** Live adapter over `InspectorSeekFooterView`: seek, and play the padded timeline range. */
export function InspectorSeekFooter({
  seekSec,
  playStart,
  playEnd,
  padSec,
  ...view
}: Props) {
  return (
    <InspectorSeekFooterView
      {...view}
      onSeek={() => void seekTransport(seekSec)}
      onPlay={() => {
        const r = playSpan(playStart, playEnd, padSec);
        if (r.status === "disabled")
          useDawStore.getState().announceStatus(r.reason, { tone: "error" });
      }}
    />
  );
}
