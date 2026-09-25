import type { WaveformTile } from "../audio/waveformTiles";
import type { ResolvedTheme } from "../hooks/useTheme";
import type { PeaksData } from "../types/project";
import { peakAmp, peakIndexRange, WAVEFORM_OVERSCAN_PX } from "../utils/peaks";
import { paintDpr } from "../utils/timelineZoom.generated";

export { WAVEFORM_OVERSCAN_PX } from "../utils/peaks";
// Clip tints moved to waveformTheme.ts; re-exported until the old painter goes.
export { clipWaveformFill, parseRgb } from "./waveformTheme";

export type VisibleClipWindow = {
  cssWidth: number;
  canvasLeft: number;
  sourceStart: number;
  sourceEnd: number;
  offscreen: boolean;
};

export function visibleClipWindow(input: {
  clipTimelineStart: number;
  clipSourceStart: number;
  clipSourceEnd: number;
  zoomPxPerSec: number;
  scrollLeft: number;
  viewportWidth: number;
  overscanPx?: number;
}): VisibleClipWindow {
  const overscan = input.overscanPx ?? WAVEFORM_OVERSCAN_PX;
  const zoom = Math.max(input.zoomPxPerSec, 1e-6);
  const clipLeft = input.clipTimelineStart * zoom;
  const duration = Math.max(0, input.clipSourceEnd - input.clipSourceStart);
  const clipWidth = duration * zoom;
  const viewL = input.scrollLeft - overscan;
  const viewR = input.scrollLeft + input.viewportWidth + overscan;
  const visL = Math.max(clipLeft, viewL);
  const visR = Math.min(clipLeft + clipWidth, viewR);
  if (!(visR > visL) || !(input.viewportWidth > 0)) {
    return {
      cssWidth: 0,
      canvasLeft: 0,
      sourceStart: input.clipSourceStart,
      sourceEnd: input.clipSourceStart,
      offscreen: true,
    };
  }
  const canvasLeft = visL - clipLeft;
  const cssWidth = visR - visL;
  const sourceStart = input.clipSourceStart + canvasLeft / zoom;
  const sourceEnd = sourceStart + cssWidth / zoom;
  return {
    cssWidth,
    canvasLeft,
    sourceStart,
    sourceEnd,
    offscreen: false,
  };
}

export function rangeMaxColumn(
  peaks: ArrayLike<number>,
  start: number,
  end: number,
): number {
  const i0 = Math.max(0, Math.floor(start));
  const i1 = Math.min(peaks.length, Math.ceil(end));
  let m = 0;
  for (let i = i0; i < i1; i++) {
    const v = peaks[i] ?? 0;
    if (v > m) {
      m = v;
    }
  }
  return m;
}

export type PaintWaveformOpts = {
  peaks: PeaksData | null;
  tiles: WaveformTile[];
  sourceStart: number;
  sourceEnd: number;
  cssWidth: number;
  ampZoom: number;
  devicePixelRatio?: number;
  peakFill?: string;
  /** Mid-line tint; with `peakFillEdge`, draws a gradient mirrored at mid. */
  peakFillCore?: string;
  /** Tint at the canvas edges, reached only by loud peaks. */
  peakFillEdge?: string;
};

/** Everything that decides a waveform canvas's pixels (its paint key). */
export type WaveformPaintInputs = {
  peaks: PeaksData | null;
  tiles: WaveformTile[];
  sourceStart: number;
  sourceEnd: number;
  cssWidth: number;
  ampZoom: number;
  devicePixelRatio: number;
  /** The canvas fills the clip, whose height follows the lane. */
  laneHeight: number;
  /** Lane colour and resolved theme pick the tint. */
  color: string;
  theme: ResolvedTheme;
};

/**
 * True when a canvas painted with `prev` would get the same pixels from
 * `next`, so the paint can be skipped. Tiles compare by identity (the tile
 * LRU hands back the same objects); peaks by reference.
 */
export function samePaintInputs(
  prev: WaveformPaintInputs | undefined,
  next: WaveformPaintInputs,
): boolean {
  return (
    prev != null &&
    prev.peaks === next.peaks &&
    prev.sourceStart === next.sourceStart &&
    prev.sourceEnd === next.sourceEnd &&
    prev.cssWidth === next.cssWidth &&
    prev.ampZoom === next.ampZoom &&
    prev.devicePixelRatio === next.devicePixelRatio &&
    prev.laneHeight === next.laneHeight &&
    prev.color === next.color &&
    prev.theme === next.theme &&
    prev.tiles.length === next.tiles.length &&
    prev.tiles.every((tile, i) => tile === next.tiles[i])
  );
}

export function paintWaveform(
  canvas: HTMLCanvasElement,
  opts: PaintWaveformOpts,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const h = canvas.offsetHeight || 40;
  const dpr = paintDpr(opts.devicePixelRatio ?? 1);
  const drawW = Math.max(0, Math.floor(opts.cssWidth));
  if (drawW <= 0 || h <= 0) {
    return;
  }
  // Reassigning width/height reallocates the backing store even when equal.
  const backingW = Math.floor(drawW * dpr);
  const backingH = Math.floor(h * dpr);
  if (canvas.width !== backingW) {
    canvas.width = backingW;
  }
  if (canvas.height !== backingH) {
    canvas.height = backingH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, drawW, h);
  if (opts.peakFillCore && opts.peakFillEdge) {
    // Mirrored around the midline: both lobes shade alike, loud peaks glow.
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, opts.peakFillEdge);
    gradient.addColorStop(0.5, opts.peakFillCore);
    gradient.addColorStop(1, opts.peakFillEdge);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = opts.peakFill || "rgba(255,255,255,0.35)";
  }
  const mid = h / 2;
  const ampZoom = Math.max(1, opts.ampZoom);
  const duration = Math.max(1e-9, opts.sourceEnd - opts.sourceStart);
  for (let x = 0; x < drawW; x++) {
    const t0 = opts.sourceStart + (x / drawW) * duration;
    const t1 = opts.sourceStart + ((x + 1) / drawW) * duration;
    const amp = sampleAmp(opts.tiles, opts.peaks, t0, t1) * ampZoom;
    const bar = Math.min(1, amp) * mid * 0.9;
    if (bar > 0.15) {
      ctx.fillRect(x, mid - bar, 1, bar * 2);
    }
  }
}

function sampleAmp(
  tiles: WaveformTile[],
  peaks: PeaksData | null,
  t0: number,
  t1: number,
): number {
  for (const tile of tiles) {
    if (t1 <= tile.startSec || t0 >= tile.endSec) {
      continue;
    }
    const lo = Math.max(t0, tile.startSec);
    const hi = Math.min(t1, tile.endSec);
    const span = tile.endSec - tile.startSec;
    if (span <= 0 || tile.peaks.length === 0) {
      continue;
    }
    const i0 = ((lo - tile.startSec) / span) * tile.peaks.length;
    const i1 = ((hi - tile.startSec) / span) * tile.peaks.length;
    return peakAmp(rangeMaxColumn(tile.peaks, i0, i1));
  }
  if (!peaks) {
    return 0;
  }
  const [a, b] = peakIndexRange(peaks, t0, t1);
  if (b <= a) {
    return 0;
  }
  return peakAmp(rangeMaxColumn(peaks.peaks, a, b));
}
