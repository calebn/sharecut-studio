import { clampToSession } from "./time";

/**
 * Convert a pointer clientX to timeline seconds.
 *
 * Pass a canvas `HTMLElement` (lanes, lane-row) whose `getBoundingClientRect`
 * already includes ancestor scroll — do not add `scrollLeft` again.
 * Pass a viewport-stable `{ left }` origin (scrollport + headers) with the
 * scroller's `scrollLeft`.
 */

export function clientXToTimelineSec(
  clientX: number,
  target: Pick<DOMRectReadOnly, "left"> | HTMLElement,
  scrollLeft: number,
  zoomPxPerSec: number,
  durationSec: number,
): number {
  const fromCanvas = "getBoundingClientRect" in target;
  const left = fromCanvas ? target.getBoundingClientRect().left : target.left;
  const zoom = zoomPxPerSec > 0 ? zoomPxPerSec : 1;
  const x = clientX - left + (fromCanvas ? 0 : scrollLeft);
  return clampToSession(x / zoom, durationSec);
}
