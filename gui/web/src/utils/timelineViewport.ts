import { clientXToTimelineSec } from "./timelinePointer";

/** The sticky track-header column inside `.timeline-scroll`, if any. */
export function timelineHeaderEl(
  scrollEl: Pick<HTMLElement, "querySelector"> | null | undefined,
): HTMLElement | null {
  return scrollEl?.querySelector<HTMLElement>(".track-headers") ?? null;
}

/** Sticky track-header width inside `.timeline-scroll` (0 when no headerSlot). */
export function timelineHeaderOffsetWidth(
  scrollEl: Pick<HTMLElement, "querySelector"> | null | undefined,
): number {
  const header = timelineHeaderEl(scrollEl);
  if (!header || typeof header.offsetWidth !== "number") {
    return 0;
  }
  return header.offsetWidth;
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

/** Offset from the time viewport's left edge to its center. */
export function viewportCenterOffsetPx(viewportWidthPx: number): number {
  return Math.max(0, viewportWidthPx) / 2;
}

/**
 * Fixed-playhead (phone) timelines pad the time column by the center offset
 * on each side, so every time from 0 to the end can sit under the center line
 * even at fit zoom. Store `scrollLeft` stays logical (time × zoom from the
 * column's left edge); the scroller's DOM `scrollLeft` is logical + lead, so
 * a logical value can go as low as −lead.
 */
export function fixedPlayheadLeadPx(viewportWidthPx: number): number {
  return viewportCenterOffsetPx(viewportWidthPx);
}

/**
 * A fixed-playhead canvas is exactly the session: the lead pads fill the
 * viewport, so the scroll range ends with the session end under the line
 * even below fit zoom, instead of stopping there by writing the scroll back.
 */
export function fixedPlayheadCanvasSize(
  sessionSec: number,
  zoomPxPerSec: number,
): { widthPx: number; durationSec: number } {
  const durationSec = Math.max(0, sessionSec);
  return { widthPx: durationSec * Math.max(zoomPxPerSec, 0), durationSec };
}

/** Lowest logical scroll: −lead in a padded view, +0 otherwise. */
export function minLogicalScrollLeft(leadPx: number): number {
  return leadPx > 0 ? -leadPx : 0;
}

/** Where the fixed line sits in the scroller: past the headers, at center. */
export function fixedPlayheadLinePx(
  headerPx: number,
  viewportWidthPx: number,
): number {
  return headerPx + viewportCenterOffsetPx(viewportWidthPx);
}

export function logicalToDomScrollLeft(
  logical: number,
  leadPx: number,
): number {
  return logical + leadPx;
}

export function domToLogicalScrollLeft(dom: number, leadPx: number): number {
  return dom - leadPx;
}

/** Scroll writes within this of the DOM value are already applied. */
export const SCROLL_SYNC_EPS_PX = 0.5;

/**
 * A playhead or scroll change smaller than this is not a move: the line
 * cannot show it, and rounding or clamp noise stays below it.
 */
export const PLAYHEAD_MOVE_MIN_PX = 1;

/** Logical `scrollLeft` that puts `sec` at the center of the time viewport. */
export function centerSecToScrollLeft(
  sec: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
): number {
  return sec * zoomPxPerSec - viewportCenterOffsetPx(viewportWidthPx);
}

/** Time at the center of the time viewport, clamped to [0, maxSec]. */
export function scrollLeftToCenterSec(
  scrollLeft: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
  maxSec: number,
): number {
  return clientXToTimelineSec(
    viewportCenterOffsetPx(viewportWidthPx),
    { left: 0 },
    scrollLeft,
    zoomPxPerSec,
    maxSec,
  );
}
