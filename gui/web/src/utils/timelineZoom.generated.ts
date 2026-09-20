/** Generated from contracts/timeline-zoom.json — do not edit by hand. */

export const MIN_ZOOM_PX_PER_SEC = 0.05;
export const MAX_ZOOM_PX_PER_SEC = 200;
export const ZOOM_STEP = 1.25;
export const OVERVIEW_DECODE_HZ = 8000;
export const OVERVIEW_BINS_PER_SEC = 16;
export const OVERVIEW_SAMPLES_PER_PIXEL = 500;
export const DPR_HEADROOM = 2;
export const PAINT_DPR_CAP = 2;
export const TILE_SEC = 2;
export const EDIT_FOCUS_SEC = 0.2;
export const EDIT_FOCUS_MULTIPLIER = 8;
export const FINEST_BINS_PER_SEC = 400;

export function paintDpr(devicePixelRatio: number): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.min(Math.max(dpr, 1), PAINT_DPR_CAP);
}

export function detailBinsPerSec(
  zoomPxPerSec: number,
  devicePixelRatio: number,
): number {
  return Math.min(
    zoomPxPerSec * paintDpr(devicePixelRatio),
    FINEST_BINS_PER_SEC,
  );
}

export function editFocusBinsPerSec(
  zoomPxPerSec: number,
  devicePixelRatio: number,
): number {
  return Math.min(
    detailBinsPerSec(zoomPxPerSec, devicePixelRatio) * EDIT_FOCUS_MULTIPLIER,
    OVERVIEW_DECODE_HZ,
  );
}
