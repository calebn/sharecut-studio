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
  | "suggestDisabled"
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
  const { setPlayheadSec, setPlayUntilSec, setIsPlaying, beginAudition } =
    useDaw((s) => ({
      setPlayheadSec: s.setPlayheadSec,
      setPlayUntilSec: s.setPlayUntilSec,
      setIsPlaying: s.setIsPlaying,
      beginAudition: s.beginAudition,
    }));

  return (
    <InspectorSeekFooterView
      {...view}
      onSeek={() => setPlayheadSec(seekSec)}
      onPlay={() =>
        playTimelineRange({
          start: playStart,
          end: playEnd,
          padSec,
          beginAudition,
          setPlayheadSec,
          setPlayUntilSec,
          setIsPlaying,
        })
      }
    />
  );
}
