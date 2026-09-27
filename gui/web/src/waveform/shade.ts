import { linearToDb } from "../utils/audio";
import {
  COARSE_COLUMN_SEC,
  COARSE_PEAK_ALPHA,
  WAVEFORM_LOG_FLOOR_DB,
} from "../utils/timelineZoom.generated";
import { reduceEnvelope, reducePcmEnvelope } from "./pyramidMath";
import type {
  Envelope,
  RasterJob,
  RasterMode,
  Rgba,
  WaveformScale,
} from "./types";

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
 * `|v|·gain` as a 0..1 fraction of the half-lane. Linear clamps at full
 * scale; log maps dBFS above `log_floor_db` (−54) linearly, so −30 dBFS
 * lands at 0.44 and anything at or under the floor (or digital zero) at 0.
 */
export function displayAmplitude(
  v: number,
  gain: number,
  scale: WaveformScale,
): number {
  const a = Math.abs(v) * gain;
  if (scale === "linear") {
    return Math.min(1, a);
  }
  // linearToDb(0 or NaN) is -Infinity, which clamps to 0.
  return clamp(
    (linearToDb(a) - WAVEFORM_LOG_FLOOR_DB) / -WAVEFORM_LOG_FLOOR_DB,
    0,
    1,
  );
}

/** `displayAmplitude` keeping the sample's side of the centre line. */
function displaySigned(v: number, gain: number, scale: WaveformScale): number {
  return Math.sign(v) * displayAmplitude(v, gain, scale);
}

/**
 * The peak tint for columns of `secPerCol` media seconds: past
 * `coarse_column_sec` (50 ms) its alpha drops to `coarse_peak_alpha`, so the
 * RMS body reads as the shape and one transient per column no longer fills
 * the lane. Finer columns keep `edge` as is.
 */
export function coarsePeakEdge(edge: Rgba, secPerCol: number): Rgba {
  if (!(secPerCol > COARSE_COLUMN_SEC)) {
    return edge;
  }
  return new Float32Array([
    edge[0]!,
    edge[1]!,
    edge[2]!,
    edge[3]! * COARSE_PEAK_ALPHA,
  ]);
}

/**
 * Per-column geometry in device rows: the peak span `[top, bot]` and the
 * RMS body `[rmsTop, rmsBot]` inside it. Skipped columns (no data, silence)
 * and an empty RMS body are `[-1, -1]`, which covers no row. Amplitudes map
 * through `displayAmplitude` under `scale`.
 */
export function columnGeometry(
  env: Envelope,
  ampZoom: number,
  rows: number,
  mode: RasterMode,
  scale: WaveformScale,
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
    // Pyramid bins aggregate many frames, so a peak under SILENCE_ROWS marks
    // a genuinely quiet region worth erasing. PCM/line columns are a single
    // reading (one sample or a tiny window): on a short lane the same peak
    // can fall under the (lane-height-scaled) cutoff even though it is real
    // data, not noise — `minThick` below already keeps it visible, so only
    // pyramid columns are suppressed here.
    if (
      mode === "pyramid" &&
      displayAmplitude(Math.max(Math.abs(mn), Math.abs(mx)), ampZoom, scale) *
        sc <
        SILENCE_ROWS
    ) {
      continue;
    }
    let top = mid - displaySigned(mx, ampZoom, scale) * sc;
    let bot = mid - displaySigned(mn, ampZoom, scale) * sc;
    if (bot - top < minThick) {
      const centre = (top + bot) / 2;
      top = centre - minThick / 2;
      bot = centre + minThick / 2;
    }
    const r = displayAmplitude(env.rms[c]!, ampZoom, scale) * sc;
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
  return columnGeometry(
    jobEnvelope(job),
    job.ampZoom,
    job.rows,
    job.mode,
    job.scale,
  );
}
