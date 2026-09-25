import { reduceEnvelope, reducePcmEnvelope } from "./pyramidMath";
import type { Envelope, RasterJob, RasterMode, Rgba } from "./types";

/**
 * Shading (S6), shared by the CPU and WebGL2 rasterizers: both draw from the
 * per-column geometry built here and the same row-coverage formula, so the
 * two backends cannot drift apart.
 */

/** Values per column in the geometry: `top, bot, rmsTop, rmsBot` (rows). */
export const GEOMETRY_VALUES = 4;

/** Thinnest drawn column (device rows): a pyramid hairline, a PCM line. */
export const MIN_THICK: Record<RasterMode, number> = {
  pyramid: 1,
  pcm: 1.5,
  line: 1.5,
};

/** A column below this many rows is silence and stays empty. */
export const SILENCE_ROWS = 0.15;

/** Span that covers no row. */
const NONE = -1;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Per-column geometry in device rows: the peak span `[top, bot]` and the
 * RMS body `[rmsTop, rmsBot]` inside it. Skipped columns (no data, silence)
 * and an empty RMS body are `[-1, -1]`, which covers no row.
 */
export function columnGeometry(
  env: Envelope,
  ampZoom: number,
  rows: number,
  mode: RasterMode,
): Float32Array {
  const out = new Float32Array(env.cols * GEOMETRY_VALUES).fill(NONE);
  const mid = rows / 2;
  const sc = 0.9 * mid;
  const minThick = MIN_THICK[mode];
  for (let c = 0; c < env.cols; c++) {
    if (!env.has[c]) {
      continue;
    }
    const mn = env.min[c]!;
    const mx = env.max[c]!;
    if (Math.max(Math.abs(mn), Math.abs(mx)) * ampZoom * sc < SILENCE_ROWS) {
      continue;
    }
    let top = mid - clamp(mx * ampZoom, -1, 1) * sc;
    let bot = mid - clamp(mn * ampZoom, -1, 1) * sc;
    if (bot - top < minThick) {
      const centre = (top + bot) / 2;
      top = centre - minThick / 2;
      bot = centre + minThick / 2;
    }
    const r = clamp(env.rms[c]! * ampZoom, 0, 1) * sc;
    const rTop = Math.max(mid - r, top);
    const rBot = Math.min(mid + r, bot);
    const o = c * GEOMETRY_VALUES;
    out[o] = top;
    out[o + 1] = bot;
    if (rBot > rTop) {
      out[o + 2] = rTop;
      out[o + 3] = rBot;
    }
  }
  return out;
}

/** How much of device row `[y, y + 1)` the span `[a, b]` covers (0..1). */
export function rowCoverage(y: number, a: number, b: number): number {
  return Math.max(0, Math.min(y + 1, b) - Math.max(y, a));
}

/** Premultiplied copy of a straight RGBA colour. */
export function premultiply(c: Rgba): Float32Array {
  const a = c[3]!;
  return new Float32Array([c[0]! * a, c[1]! * a, c[2]! * a, a]);
}

/** The job's envelope, from pyramid bins or host PCM. */
export function jobEnvelope(job: RasterJob): Envelope {
  const src = job.source;
  return src.kind === "pyramid"
    ? reduceEnvelope(
        src.bins,
        src.binStart,
        src.spp,
        job.frameStart,
        job.sppDev,
        job.cols,
      )
    : reducePcmEnvelope(
        src.pcm,
        src.pcmStart,
        job.frameStart,
        job.sppDev,
        job.cols,
      );
}

/** The job's column geometry: envelope reduction then shading geometry. */
export function jobGeometry(job: RasterJob): Float32Array {
  return columnGeometry(jobEnvelope(job), job.ampZoom, job.rows, job.mode);
}
