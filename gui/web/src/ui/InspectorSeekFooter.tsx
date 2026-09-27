import { useDaw } from "../state/useDaw";
import {
  playAbRange,
  playSuggestedRange,
  playTimelineRange,
} from "../utils/playRange";
import {
  InspectorSeekFooterView,
  type InspectorSeekFooterViewProps,
} from "./InspectorSeekFooterView";

type Props = Omit<InspectorSeekFooterViewProps, "onSeek" | "onPlay"> & {
  seekSec: number;
  playStart: number;
  playEnd: number;
  padSec?: number;
};

/** Live adapter over `InspectorSeekFooterView`. */
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

  const play = () => {
    const mode = view.previewMode ?? "current";
    const blocked = view.suggestDisabled ?? false;
    if (mode === "suggested" && !blocked) {
      playSuggestedRange({
        skipStart: playStart,
        skipEnd: playEnd,
        padSec,
        beginAudition,
      });
      return;
    }
    if (mode === "ab" && !blocked) {
      playAbRange({
        skipStart: playStart,
        skipEnd: playEnd,
        padSec,
        beginAudition,
      });
      return;
    }
    playTimelineRange({
      start: playStart,
      end: playEnd,
      padSec,
      beginAudition,
      setPlayheadSec,
      setPlayUntilSec,
      setIsPlaying,
    });
  };

  return (
    <InspectorSeekFooterView
      {...view}
      onSeek={() => setPlayheadSec(seekSec)}
      onPlay={play}
    />
  );
}
