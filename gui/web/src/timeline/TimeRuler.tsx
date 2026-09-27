import { useCallback, useMemo } from "react";
import { useDawStore } from "../state/dawStore";
import {
  MIN_TIMELINE_WIDTH_PX,
  viewportChunkRange,
} from "../utils/timelineViewport";
import { Playhead } from "./Playhead";
import { TimeRulerView, type TimeRulerViewProps } from "./TimeRulerView";

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
  const chunkRange = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) =>
        viewportChunkRange(s.scrollLeft, s.timelineViewportWidth, width).join(
          ":",
        ),
      [width],
    ),
  );
  const visibleChunks = useMemo(() => {
    const [start = 0, end = 0] = chunkRange.split(":").map(Number);
    return [start, end] as const;
  }, [chunkRange]);

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
