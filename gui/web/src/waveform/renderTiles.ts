import {
  LINE_MODE_MAX_SAMPLES_PER_PX,
  OVERSCAN_CSS_PX,
  PCM_BLOCK_FRAMES,
  paintDpr,
  RENDER_TILE_CSS_PX,
} from "../utils/timelineZoom.generated";
import { binRangeForFrames, levelFor } from "./pyramidMath";
import type { PyramidMeta, RasterMode, WaveformStyle } from "./types";

/**
 * Client tile model and geometry (S5), all pure. Render tiles are anchored
 * to the media, not the clip: tile `k` covers media seconds
 * `[k·512/zoom, (k+1)·512/zoom)`, so moving, trimming or splitting a clip
 * only shifts where tiles sit.
 */

const TILE = RENDER_TILE_CSS_PX;

/** Paint DPR `d` and the tile width in device px (`512·d`, an integer). */
export function renderScale(devicePixelRatio: number): {
  d: number;
  tileDev: number;
} {
  const d = paintDpr(devicePixelRatio);
  return { d, tileDev: TILE * d };
}

/** Media frames per device column. */
export function samplesPerDevicePx(
  sampleRate: number,
  zoom: number,
  d: number,
): number {
  return sampleRate / (zoom * d);
}

/**
 * Clip-local CSS x of media time 0, snapped so tile edges land on real device
 * pixels: `round((clipLeft − mediaStart·zoom)·dpr)/dpr − clipLeft`.
 */
export function tileOrigin(opts: {
  clipLeftCss: number;
  mediaStartSec: number;
  zoom: number;
  dprReal: number;
}): number {
  const { clipLeftCss, mediaStartSec, zoom, dprReal } = opts;
  const dpr = dprReal > 0 && Number.isFinite(dprReal) ? dprReal : 1;
  return (
    Math.round((clipLeftCss - mediaStartSec * zoom) * dpr) / dpr - clipLeftCss
  );
}

/**
 * Render tiles `[k0, k1]` of a clip that meet the view plus overscan, or
 * null. `scrollLeft` and `viewportWidth` are the logical store values.
 */
export function visibleTileRange(opts: {
  origin: number;
  clipLeftCss: number;
  clipWidthCss: number;
  scrollLeft: number;
  viewportWidth: number;
}): [number, number] | null {
  const { origin, clipLeftCss, clipWidthCss, scrollLeft, viewportWidth } = opts;
  const viewL = scrollLeft - OVERSCAN_CSS_PX;
  const viewR = scrollLeft + viewportWidth + OVERSCAN_CSS_PX;
  const lo = Math.max(0, viewL - clipLeftCss);
  const hi = Math.min(clipWidthCss, viewR - clipLeftCss);
  if (hi <= lo) {
    return null;
  }
  const k0 = Math.max(0, Math.floor((lo - origin) / TILE));
  const k1 = Math.ceil((hi - origin) / TILE) - 1;
  return k1 >= k0 ? [k0, k1] : null;
}

/** Where tile `k`'s canvas sits in the clip and which bitmap columns it shows. */
export type TileRect = {
  /** Clip-local CSS left and width of the canvas. */
  left: number;
  width: number;
  /** Bitmap device columns `[sx, sx + sw)` drawn into it. */
  sx: number;
  sw: number;
};

/**
 * The canvas covers only the part of tile `k` inside the clip:
 * `a = max(L, 0)`, `b = min(L + 512, clipWidth)`, `sx = floor((a − L)·d)`,
 * `sw = ceil((b − L)·d) − sx`, `left = L + sx/d`, `width = sw/d`.
 */
export function tileRect(
  k: number,
  origin: number,
  clipWidthCss: number,
  d: number,
): TileRect | null {
  const L = k * TILE + origin;
  const a = Math.max(L, 0);
  const b = Math.min(L + TILE, clipWidthCss);
  if (b <= a) {
    return null;
  }
  const sx = Math.floor((a - L) * d);
  const sw = Math.ceil((b - L) * d) - sx;
  return { left: L + sx / d, width: sw / d, sx, sw };
}

/** Backing-store rows of the layer. */
export function heightDevice(heightCss: number, d: number): number {
  return Math.round(heightCss * d);
}

/** Core and edge RGBA joined: tiles re-render when the look changes. */
export function styleKey(style: WaveformStyle): string {
  return [...style.core, ...style.edge].map((v) => v.toFixed(4)).join(",");
}

export type TileIdentity = {
  mediaKey: string;
  zoom: number;
  d: number;
  heightDev: number;
  styleKey: string;
  ampZoom: number;
};

/** What a stand-in must share with a tile (everything but zoom and `k`). */
export function tileGroup(id: TileIdentity): string {
  return `${id.mediaKey}|${id.styleKey}|${id.heightDev}|${id.d}|${id.ampZoom}`;
}

/** `${mediaKey}|${zoom.toPrecision(9)}|${d}|${heightDev}|${styleKey}|${ampZoom}|${k}`. */
export function tileKey(id: TileIdentity, k: number): string {
  return `${id.mediaKey}|${id.zoom.toPrecision(9)}|${id.d}|${id.heightDev}|${id.styleKey}|${id.ampZoom}|${k}`;
}

/**
 * Pyramid while a device column spans at least a level-0 bin or there is no
 * PCM access (guests); PCM below that, drawn as a line under
 * `line_mode_max_samples_per_px` frames per column.
 */
export function rasterMode(
  sppDev: number,
  baseSpp: number,
  hasPcm: boolean,
): RasterMode {
  if (sppDev >= baseSpp || !hasPcm) {
    return "pyramid";
  }
  return sppDev < LINE_MODE_MAX_SAMPLES_PER_PX ? "line" : "pcm";
}

/** Level to draw a pyramid tile from; below level 0, level 0 bins span pixels. */
export function drawLevel(
  meta: Pick<PyramidMeta, "levels">,
  sppDev: number,
): number {
  return Math.max(0, levelFor(meta, sppDev));
}

/** Media frames tile `k` covers: its first frame, frames per column, columns. */
export function tileFrames(
  k: number,
  sampleRate: number,
  zoom: number,
  d: number,
): { frameStart: number; frames: number; sppDev: number; cols: number } {
  const sppDev = samplesPerDevicePx(sampleRate, zoom, d);
  const cols = TILE * d;
  return {
    frameStart: ((k * TILE) / zoom) * sampleRate,
    frames: sppDev * cols,
    sppDev,
    cols,
  };
}

/** Data tiles `[t0, t1]` of a level that hold the bins of those frames, or null. */
export function dataTilesFor(
  meta: Pick<PyramidMeta, "levels" | "bins_per_tile">,
  level: number,
  frameStart: number,
  frames: number,
): [number, number] | null {
  const [b0, b1] = binRangeForFrames(
    meta,
    level,
    frameStart,
    frameStart + frames,
  );
  if (b1 <= b0) {
    return null;
  }
  return [
    Math.floor(b0 / meta.bins_per_tile),
    Math.floor((b1 - 1) / meta.bins_per_tile),
  ];
}

/** PCM blocks `[b0, b1]` holding frames `[frameStart, frameStart + frames]`. */
export function pcmBlocksFor(
  frameStart: number,
  frames: number,
  totalFrames: number,
): [number, number] | null {
  const f0 = Math.max(0, Math.floor(frameStart));
  // The interpolant reads one frame past the tile's right edge.
  const f1 = Math.min(totalFrames - 1, Math.ceil(frameStart + frames));
  if (f1 < f0) {
    return null;
  }
  return [Math.floor(f0 / PCM_BLOCK_FRAMES), Math.floor(f1 / PCM_BLOCK_FRAMES)];
}

/**
 * Drawing a stand-in: bitmap columns `[sx, sx + sw)` of the source tile go to
 * CSS `[dx, dx + dw)` of the target tile (both over their shared seconds).
 */
export function placeholderMapping(
  src: { zoom: number; tile: number; width: number },
  dst: { zoom: number; tile: number },
): { sx: number; sw: number; dx: number; dw: number } | null {
  const s0 = (src.tile * TILE) / src.zoom;
  const s1 = ((src.tile + 1) * TILE) / src.zoom;
  const t0 = (dst.tile * TILE) / dst.zoom;
  const t1 = ((dst.tile + 1) * TILE) / dst.zoom;
  const o0 = Math.max(s0, t0);
  const o1 = Math.min(s1, t1);
  if (o1 <= o0) {
    return null;
  }
  const perSec = src.width / (s1 - s0);
  return {
    sx: (o0 - s0) * perSec,
    sw: (o1 - o0) * perSec,
    dx: (o0 - t0) * dst.zoom,
    dw: (o1 - o0) * dst.zoom,
  };
}
