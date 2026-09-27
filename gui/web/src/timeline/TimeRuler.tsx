import { useDawStore } from "../state/dawStore";
import { MIN_TIMELINE_WIDTH_PX } from "../utils/timelineViewport";
import { Playhead } from "./Playhead";
import { TimeRulerView, type TimeRulerViewProps } from "./TimeRulerView";
import { useVisibleChunks } from "./useVisibleChunks";

type TimeRulerProps = Omit<
  TimeRulerViewProps,
  "valueSec" | "getPlayheadSec" | "visibleChunks" | "playhead"
> & { hidePlayhead?: boolean };

/**
 * The slider's value: the playhead, in quarter seconds while playing so the
 * ruler re-renders four times a second rather than every frame.
 */
function selectRulerValueSec(s: {
  isPlaying: boolean;
  playheadSec: number;
}): number {
  return s.isPlaying ? Math.floor(s.playheadSec * 4) / 4 : s.playheadSec;
}

/** Live DAW wiring; the Playhead keeps its per-frame DOM transform updates. */
export function TimeRuler({ hidePlayhead = false, ...props }: TimeRulerProps) {
  const valueSec = useDawStore(selectRulerValueSec);
  const width = Math.max(
    props.durationSec * props.zoomPxPerSec,
    MIN_TIMELINE_WIDTH_PX,
  );
  const visibleChunks = useVisibleChunks(width);

  return (
    <TimeRulerView
      {...props}
      valueSec={valueSec}
      getPlayheadSec={() => useDawStore.getState().playheadSec}
      visibleChunks={visibleChunks}
      playhead={hidePlayhead ? null : <Playhead height="100%" />}
    />
  );
}
