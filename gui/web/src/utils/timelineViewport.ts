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
  return timeColumnPx(
    scrollEl.clientWidth,
    timelineHeaderOffsetWidth(scrollEl),
  );
}

function timeColumnPx(scrollportPx: number, headerPx: number): number {
  return Math.max(0, scrollportPx - headerPx);
}

/** The scroller's column geometry (px), from one pass of reads. */
export type TimelineColumns = {
  /** The sticky track-header column. */
  headerOffsetPx: number;
  /** The visible time column: the scrollport minus the header column. */
  timeViewportPx: number;
  /** Classic scrollbars (0 when they overlay): the vertical one's width. */
  scrollbarInlinePx: number;
  /** …and the horizontal one's height. */
  scrollbarBlockPx: number;
};

/** Measure the header, time column and scrollbars of `.timeline-scroll`. */
export function measureTimelineColumns(
  scrollEl: Pick<
    HTMLElement,
    | "clientWidth"
    | "clientHeight"
    | "offsetWidth"
    | "offsetHeight"
    | "querySelector"
  >,
): TimelineColumns {
  const headerOffsetPx = timelineHeaderOffsetWidth(scrollEl);
  return {
    headerOffsetPx,
    timeViewportPx: timeColumnPx(scrollEl.clientWidth, headerOffsetPx),
    scrollbarInlinePx: Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth),
    scrollbarBlockPx: Math.max(
      0,
      scrollEl.offsetHeight - scrollEl.clientHeight,
    ),
  };
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
 * Fixed-playhead (phone) timelines pad the time column so the playhead can
 * be scrubbed to any time. The start pad is the center offset: scrolling back
 * from a centered playhead can reach time 0 under the line. Store `scrollLeft`
 * stays logical (time × zoom from the column's left edge); the scroller's DOM
 * `scrollLeft` is logical + this lead, so a logical value can go as low as
 * −lead. A timeline loads at logical 0 with time 0 right after the headers.
 */
export function fixedPlayheadLeadPx(viewportWidthPx: number): number {
  // Whole pixels, so logical 0 is a scroll position a browser can hold.
  return Math.floor(viewportCenterOffsetPx(viewportWidthPx));
}

/**
 * The end pad is a full viewport: a playhead left of center (a fresh load, a
 * pan) still scrubs to the session end, which then sits at the left edge.
 */
export function fixedPlayheadEndLeadPx(viewportWidthPx: number): number {
  return Math.floor(Math.max(0, viewportWidthPx));
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

/**
 * Where the playhead sits in the time viewport (px from its left edge): its
 * true place, kept inside the view. At load that is the left edge; playback
 * and seeks bring it to the center and hold it there.
 */
export function fixedLineOffsetPx(
  sec: number,
  zoomPxPerSec: number,
  scrollLeft: number,
  viewportWidthPx: number,
): number {
  const x = sec * zoomPxPerSec - scrollLeft;
  return Math.min(Math.max(0, viewportWidthPx), Math.max(0, x));
}

/** Where the fixed line sits in the scroller: past the headers, at its offset. */
export function fixedPlayheadLinePx(
  headerPx: number,
  lineOffsetPx: number,
): number {
  return headerPx + lineOffsetPx;
}

/** Highest logical scroll: the session end at the left edge. */
export function maxLogicalScrollLeft(
  sessionSec: number,
  zoomPxPerSec: number,
): number {
  return Math.max(0, sessionSec) * Math.max(zoomPxPerSec, 0);
}

/**
 * Time under the playhead after the view scrolls to `scrollLeft` with the
 * playhead held at `lineOffsetPx`: a scroll moves the time by exactly what it
 * moved the content.
 */
export function scrollLeftToLineSec(
  scrollLeft: number,
  lineOffsetPx: number,
  zoomPxPerSec: number,
  maxSec: number,
): number {
  return clientXToTimelineSec(
    lineOffsetPx,
    { left: 0 },
    scrollLeft,
    zoomPxPerSec,
    maxSec,
  );
}

/**
 * Logical scroll that centers `sec`, but never before time 0: near the start
 * the playhead stays left of center instead of opening a gap before 0.
 */
export function followScrollLeft(
  sec: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
): number {
  return Math.max(0, centerSecToScrollLeft(sec, zoomPxPerSec, viewportWidthPx));
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

/**
 * Long timeline overlays (ruler ticks, envelopes) mount only the chunks of
 * this many px that overlap the view, so a deep zoom never builds millions of
 * px of DOM or SVG.
 */
export const VIEWPORT_CHUNK_PX = 2048;

/** Chunks `[c0, c1]` of a `widthPx`-wide overlay that meet the time viewport. */
export function viewportChunkRange(
  scrollLeft: number,
  viewportWidth: number,
  widthPx: number,
): [number, number] {
  const last = Math.max(0, Math.ceil(widthPx / VIEWPORT_CHUNK_PX) - 1);
  const c0 = Math.floor(Math.max(0, scrollLeft) / VIEWPORT_CHUNK_PX);
  const c1 = Math.floor(
    Math.max(0, scrollLeft + Math.max(0, viewportWidth)) / VIEWPORT_CHUNK_PX,
  );
  return [Math.min(c0, last), Math.min(c1, last)];
}
