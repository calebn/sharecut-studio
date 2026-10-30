import { memo, useCallback, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { Ruler } from "../system/Ruler";
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

/** The smallest chunk the window steps by, so a tiny viewport does not render on every px. */
const MIN_CHUNK_PX = 64;

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
 * The window the ruler draws, in canvas px: where it starts and how wide it is.
 * The scroll is cut into chunks one viewport wide. The window for a chunk runs
 * from one viewport before the chunk's start to two viewports after its end,
 * so wherever the scroll sits inside the chunk, at least a full viewport of
 * ruler lies beyond each edge of the visible row. A single scroll update of up
 * to a viewport either way (a fast touch fling that outruns the next render)
 * therefore still lands on drawn ticks. The row scrolls with the lanes, so a
 * tick sits at its canvas x whatever the scroll, and the ruler re-renders only
 * when the scroll crosses into the next chunk, not on every scroll frame.
 */
function useRulerWindow(canvasWidthPx: number, viewportPx: number) {
  const view = Math.max(0, viewportPx);
  const chunkPx = Math.max(MIN_CHUNK_PX, Math.round(view));
  const lastScroll = Math.max(0, canvasWidthPx - viewportPx);
  const chunk = useDawStore(
    useCallback(
      (s: { scrollLeft: number }) =>
        Math.floor(Math.min(Math.max(0, s.scrollLeft), lastScroll) / chunkPx),
      [chunkPx, lastScroll],
    ),
  );
  const canvas = Math.max(0, canvasWidthPx);
  const left = Math.min(Math.max(0, chunk * chunkPx - view), canvas);
  const right = Math.min(canvas, chunk * chunkPx + chunkPx + 2 * view);
  return { left, width: Math.max(0, right - left) };
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
