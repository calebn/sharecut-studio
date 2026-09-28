import type { ChapterMarker } from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";

/** Space (px) kept between a chapter label and the next chapter's diamond. */
export const CHAPTER_LABEL_GAP_PX = 4;
/** Narrower than this a label would show only an ellipsis, so none is drawn. */
export const CHAPTER_LABEL_MIN_PX = 24;

/**
 * Room (px) for each chapter's title, from the right edge of its diamond to
 * just before the next chapter's diamond (the last runs to the lane end);
 * null where it would not fit. A chapter sharing its time with an earlier
 * one in the list gets null too, so titles never stack.
 */
export function chapterLabelRoomPx(
  chapters: readonly ChapterMarker[],
  zoomPxPerSec: number,
  laneWidthPx: number,
  markerPx: number = MARKER_ROW_HEIGHT,
): (number | null)[] {
  const times = chapters.map((c) => c.time).sort((a, b) => a - b);
  return chapters.map((ch, i) => {
    if (chapters.findIndex((c) => c.time === ch.time) !== i) {
      return null;
    }
    const next = times.find((t) => t > ch.time);
    const start = ch.time * zoomPxPerSec + markerPx / 2;
    const end =
      next == null
        ? laneWidthPx
        : next * zoomPxPerSec - markerPx / 2 - CHAPTER_LABEL_GAP_PX;
    const room = Math.floor(end - start);
    return room >= CHAPTER_LABEL_MIN_PX ? room : null;
  });
}
