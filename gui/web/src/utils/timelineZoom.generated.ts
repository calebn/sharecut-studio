/** Generated from contracts/timeline-zoom.json — do not edit by hand. */

export const MIN_ZOOM_PX_PER_SEC = 0.05;
export const MAX_ZOOM_PX_PER_SEC = 48000;
export const MAX_CONTENT_PX = 15000000;
export const ZOOM_STEP = 1.25;
export const PAINT_DPR_CAP = 2;
export const WAVEFORM_FORMAT_VERSION = 1;
export const BASE_SAMPLES_PER_BIN = 64;
export const LEVEL_FACTOR = 4;
export const BINS_PER_DATA_TILE = 4096;
export const MAX_TILES_PER_REQUEST = 16;
export const PCM_BLOCK_FRAMES = 65536;
export const RENDER_TILE_CSS_PX = 512;
export const OVERSCAN_CSS_PX = 512;
export const MIN_CLIP_CSS_PX = 6;
export const LINE_MODE_MAX_SAMPLES_PER_PX = 4;
export const QUIET_AMP = 0.04;
export const QUIET_MIN_DURATION_SEC = 0.12;
export const QUIET_WASH_MIN_ZOOM_PX_PER_SEC = 8;

/** Paint DPR on a 1/8 grid, so `RENDER_TILE_CSS_PX * paintDpr(d)` is an integer. */
export function paintDpr(devicePixelRatio: number): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.min(Math.max(Math.round(dpr * 8) / 8, 1), PAINT_DPR_CAP);
}

/** Zoom ceiling that keeps the timeline content under MAX_CONTENT_PX. */
export function effectiveMaxZoomPxPerSec(sessionSec: number): number {
  return Math.min(
    MAX_ZOOM_PX_PER_SEC,
    MAX_CONTENT_PX / Math.max(sessionSec, 1),
  );
}
