import { memo, useCallback, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { Ruler } from "../system/Ruler";
import { clamp } from "../utils/math";
import { Playhead } from "./Playhead";
import { timelineTestIds } from "./selectors";

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
 * The window the ruler draws: where it starts and how wide it is. The marker
 * lane takes the same three numbers, so a tick and a marker at one time share
 * one x. The window sits `scrollLeft` into the canvas, held inside it, which
 * is where the sticky wrapper rests whatever the pads around the canvas.
 */
function useRulerWindow(
  canvasWidthPx: number,
  viewportPx: number,
  zoomPxPerSec: number,
) {
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const width = Math.max(0, Math.min(viewportPx, canvasWidthPx));
  const left = clamp(scrollLeft, 0, Math.max(0, canvasWidthPx - width));
  return { start: left / zoomPxPerSec, width };
}

/**
 * The live ruler: the system Ruler over the DAW store. It is a window as wide
 * as the time viewport that sticks to it, so a deep zoom draws a screenful of
 * ticks rather than the canvas. The needle is the store-driven `Playhead`,
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
  const { start, width } = useRulerWindow(
    canvasWidthPx,
    viewportPx,
    zoomPxPerSec,
  );
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
      <div className="timeline-ruler-window">
        <Ruler
          start={start}
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
