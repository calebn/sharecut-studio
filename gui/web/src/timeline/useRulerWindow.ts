import { useCallback } from "react";
import { useDawStore } from "../state/dawStore";

/** The smallest chunk the window steps by, so a tiny viewport does not render on every px. */
const MIN_CHUNK_PX = 64;

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
 *
 * The ruler and the remote presence layer both call this with the same two
 * numbers, so the line a remote playhead draws sits on the ruler's own px.
 */
export function useRulerWindow(canvasWidthPx: number, viewportPx: number) {
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
