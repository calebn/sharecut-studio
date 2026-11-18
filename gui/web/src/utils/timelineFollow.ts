import { clamp } from "./math";
import { SCROLL_SYNC_EPS_PX } from "./timelineViewport";

type FollowGeometry = Readonly<{
  playheadSec: number;
  zoomPxPerSec: number;
  viewportPx: number;
  canvasWidthPx: number;
  scrollPx: number;
}>;

const MARGIN_FRACTION = 0.08;
const MARGIN_MIN_PX = 32;
const MARGIN_MAX_PX = 96;
const LANDING_FRACTION = 0.15;

const followMarginPx = (viewportPx: number) =>
  clamp(MARGIN_FRACTION * viewportPx, MARGIN_MIN_PX, MARGIN_MAX_PX);

const playheadX = (
  geometry: Pick<FollowGeometry, "playheadSec" | "zoomPxPerSec" | "scrollPx">,
) => geometry.playheadSec * geometry.zoomPxPerSec - geometry.scrollPx;

const clampToCanvas = (
  scrollPx: number,
  {
    viewportPx,
    canvasWidthPx,
  }: Pick<FollowGeometry, "viewportPx" | "canvasWidthPx">,
) => clamp(scrollPx, 0, Math.max(0, canvasWidthPx - viewportPx));

/**
 * Null when no page is needed. A flip lands the playhead near the left so the
 * next page lasts longest.
 */
export function followPageTarget(geometry: FollowGeometry): number | null {
  const { playheadSec, zoomPxPerSec, viewportPx, scrollPx } = geometry;
  const x = playheadX(geometry);
  if (x >= 0 && x <= viewportPx - followMarginPx(viewportPx)) {
    return null;
  }
  const target = clampToCanvas(
    playheadSec * zoomPxPerSec - Math.round(LANDING_FRACTION * viewportPx),
    geometry,
  );
  return Math.abs(target - scrollPx) <= SCROLL_SYNC_EPS_PX ? null : target;
}

export function isPlayheadOffscreen(
  geometry: Omit<FollowGeometry, "canvasWidthPx">,
): boolean {
  const x = playheadX(geometry);
  return x < 0 || x > geometry.viewportPx;
}

export function revealTargetPx(
  geometry: Omit<FollowGeometry, "scrollPx">,
): number {
  return clampToCanvas(
    geometry.playheadSec * geometry.zoomPxPerSec - geometry.viewportPx / 2,
    geometry,
  );
}
