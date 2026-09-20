/** Sticky track-header width inside `.timeline-scroll` (0 when no headerSlot). */
export function timelineHeaderOffsetWidth(
  scrollEl: Pick<HTMLElement, "querySelector"> | null | undefined,
): number {
  if (!scrollEl) {
    return 0;
  }
  const header = scrollEl.querySelector(".track-headers");
  if (!header || typeof (header as HTMLElement).offsetWidth !== "number") {
    return 0;
  }
  return (header as HTMLElement).offsetWidth;
}

/** Visible time-lane width for fit/zoom (scrollport minus sticky headers). */
export function timelineTimeViewportWidth(
  scrollEl:
    | Pick<HTMLElement, "clientWidth" | "querySelector">
    | null
    | undefined,
): number {
  if (!scrollEl) {
    return 0;
  }
  return Math.max(
    0,
    scrollEl.clientWidth - timelineHeaderOffsetWidth(scrollEl),
  );
}

export const MIN_TIMELINE_WIDTH_PX = 200;

/**
 * Visible timeline canvas when zoomed out: at least the session width, and at
 * least the time-column viewport so the ruler fills empty space past the last clip.
 * When zoomed in (session wider than the viewport), width stays session-based.
 */
export function timelineCanvasSize(
  sessionSec: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
): { widthPx: number; durationSec: number } {
  const zoom = Math.max(zoomPxPerSec, 1e-6);
  const sessionWidth = Math.max(0, sessionSec) * zoom;
  const widthPx = Math.max(
    sessionWidth,
    Math.max(0, viewportWidthPx),
    MIN_TIMELINE_WIDTH_PX,
  );
  return { widthPx, durationSec: widthPx / zoom };
}
