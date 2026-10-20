import { seekTransport } from "../commands/seek";
import { useDaw } from "../state/useDaw";
import { playTimelineRange } from "../utils/playRange";
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
  const { setPlayUntilSec, setIsPlaying, beginAudition } = useDaw((s) => ({
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
    beginAudition: s.beginAudition,
  }));

  return (
    <InspectorSeekFooterView
      {...view}
      onSeek={() => void seekTransport(seekSec)}
      onPlay={() =>
        playTimelineRange({
          setPlayheadSec: (sec) => void seekTransport(sec),
          start: playStart,
          end: playEnd,
          padSec,
          beginAudition,
          setPlayUntilSec,
          setIsPlaying,
        })
      }
    />
  );
}
