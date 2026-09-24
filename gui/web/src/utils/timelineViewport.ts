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

/**
 * Fixed-playhead (phone) timelines pad the time column by half the time
 * viewport on each side, so every time from 0 to the end can sit under the
 * centre line even at fit zoom. Store `scrollLeft` stays logical (time × zoom
 * from the column's left edge); the scroller's DOM `scrollLeft` is logical +
 * lead, so a logical value can go as low as −lead.
 */
export function fixedPlayheadLeadPx(viewportWidthPx: number): number {
  return Math.max(0, viewportWidthPx) / 2;
}

/** Logical `scrollLeft` that puts `sec` at the centre of the time viewport. */
export function scrollLeftCenteringSec(
  sec: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
): number {
  return sec * zoomPxPerSec - Math.max(0, viewportWidthPx) / 2;
}

/** Time at the centre of the time viewport, clamped to the canvas. */
export function secAtViewportCenter(
  scrollLeft: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
  canvasSec: number,
): number {
  const zoom = Math.max(zoomPxPerSec, 1e-6);
  const sec = (scrollLeft + Math.max(0, viewportWidthPx) / 2) / zoom;
  return Math.max(0, Math.min(canvasSec, sec));
}
