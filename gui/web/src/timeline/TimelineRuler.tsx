import { memo, useCallback, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { Ruler } from "../system/Ruler";
import { Playhead } from "./Playhead";
import { timelineTestIds } from "./selectors";
import { useRulerWindow } from "./useRulerWindow";

type TimelineRulerProps = {
  /** The canvas width in px: the ruler never reaches past it. */
  canvasWidthPx: number;
  /** The time viewport in px, the room beside the headers. */
  viewportPx: number;
  /** The episode length: the ruler's ends and its aria max. */
  sessionSec: number;
  zoomPxPerSec: number;
  /** The phone's fixed line is the needle, so none is drawn here. */
  fixedPlayhead: boolean;
  onSeek: (seconds: number) => void;
  onFit: () => void;
};

const ANCHOR = {
  ...presenceAnchorProps(presenceAnchor("ruler")),
  "data-testid": timelineTestIds.ruler,
};

/**
 * The slider's value: the playhead, in quarter seconds while playing so the
 * ruler re-renders four times a second rather than every frame. Rounds to the
 * nearest quarter so the announced time is never more than an eighth off.
 */
function selectRulerValueSec(s: {
  isPlaying: boolean;
  playheadSec: number;
}): number {
  return s.isPlaying ? Math.round(s.playheadSec * 4) / 4 : s.playheadSec;
}

/**
 * The live ruler: the system Ruler over the DAW store. It is a window of the
 * canvas around the time viewport, so a deep zoom draws a few screenfuls of
 * ticks rather than the whole canvas. The needle is the store-driven `Playhead`,
 * which moves by transform, so a playing playhead re-renders nothing here.
 */
export const TimelineRuler = memo(function TimelineRuler({
  canvasWidthPx,
  viewportPx,
  sessionSec,
  zoomPxPerSec,
  fixedPlayhead,
  onSeek,
  onFit,
}: TimelineRulerProps) {
  const playhead = useDawStore(selectRulerValueSec);
  const { left, width } = useRulerWindow(canvasWidthPx, viewportPx);
  const scrubFrom = useRef(0);
  const scrubStart = useCallback(() => {
    scrubFrom.current = useDawStore.getState().playheadSec;
    return true;
  }, []);
  const scrub = useCallback((seconds: number) => onSeek(seconds), [onSeek]);
  const scrubEnd = useCallback(
    (committed: boolean) => {
      if (!committed) onSeek(scrubFrom.current);
    },
    [onSeek],
  );
  return (
    <div className="timeline-ruler">
      <div className="timeline-ruler-window" style={{ insetInlineStart: left }}>
        <Ruler
          start={left / zoomPxPerSec}
          pxPerSecond={zoomPxPerSec}
          width={width}
          duration={sessionSec}
          playhead={playhead}
          hidePlayhead
          anchorProps={ANCHOR}
          onSeek={onSeek}
          onFit={onFit}
          onScrubStart={scrubStart}
          onScrub={scrub}
          onScrubEnd={scrubEnd}
        />
      </div>
      {fixedPlayhead ? null : <Playhead height="100%" />}
    </div>
  );
});
