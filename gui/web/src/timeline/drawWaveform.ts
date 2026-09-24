import type { WaveformTile } from "../audio/waveformTiles";
import type { PeaksData } from "../types/project";
import { peakAmp, peakIndexRange, WAVEFORM_OVERSCAN_PX } from "../utils/peaks";
import { paintDpr } from "../utils/timelineZoom.generated";

export { WAVEFORM_OVERSCAN_PX } from "../utils/peaks";

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

const WAVEFORM_CORE_LIGHTEN = 0.45;
const WAVEFORM_EDGE_LIGHTEN = 0.72;

const NUM = String.raw`(-?[\d.]+(?:e[-+]?\d+)?)`;
const ALPHA = String.raw`(?:\s*[,/]\s*([\d.]+%?))?`;
const RGB_RE = new RegExp(
  String.raw`^rgba?\(\s*${NUM}[\s,]+${NUM}[\s,]+${NUM}${ALPHA}\s*\)$`,
  "i",
);
/** What `getComputedStyle` returns for `color-mix()` / `oklch()` fills. */
const SRGB_RE = new RegExp(
  String.raw`^color\(\s*srgb\s+${NUM}\s+${NUM}\s+${NUM}${ALPHA}\s*\)$`,
  "i",
);

function parseAlpha(raw: string | undefined): number {
  if (raw == null) {
    return 1;
  }
  const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * Channels (0–255) and alpha (0–1) of a computed colour: `rgb()` / `rgba()`,
 * or `color(srgb r g b / a)` with 0–1 channels.
 */
function parseRgb(
  color: string,
): { rgb: [number, number, number]; alpha: number } | null {
  const text = color.trim();
  const rgb = text.match(RGB_RE);
  const srgb = rgb ? null : text.match(SRGB_RE);
  const match = rgb ?? srgb;
  if (!match) {
    return null;
  }
  const scale = srgb ? 255 : 1;
  const channel = (raw: string | undefined) =>
    Math.min(255, Math.max(0, Number(raw) * scale));
  return {
    rgb: [channel(match[1]), channel(match[2]), channel(match[3])],
    alpha: parseAlpha(match[4]),
  };
}

function towardWhite(
  [r, g, b]: [number, number, number],
  amount: number,
): string {
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Waveform tints derived from the clip's own fill, so every track keeps its
 * identity color. Returns null when the fill is unparseable or fully
 * transparent, so the themed peak color applies; partial alpha keeps the
 * channels (clip fills are opaque today).
 */
export function clipWaveformFill(
  clipBackground: string,
): { core: string; edge: string } | null {
  const parsed = parseRgb(clipBackground);
  if (!parsed || parsed.alpha === 0) {
    return null;
  }
  return {
    core: towardWhite(parsed.rgb, WAVEFORM_CORE_LIGHTEN),
    edge: towardWhite(parsed.rgb, WAVEFORM_EDGE_LIGHTEN),
  };
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
  canvas.width = Math.floor(drawW * dpr);
  canvas.height = Math.floor(h * dpr);
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
