import type { Envelope, PyramidMeta } from "./types";

/** i16 bins and PCM values are scaled by this to −1..1. */
export const I16_SCALE = 32767;

/** Values per bin: `min, max, rms`. */
export const BIN_VALUES = 3;

/**
 * The finest level whose frames per bin still fit one device column: the
 * largest ℓ with `spp ≤ sppDev`, or −1 when even level 0 is coarser.
 */
export function levelFor(
  meta: Pick<PyramidMeta, "levels">,
  sppDev: number,
): number {
  let best = -1;
  meta.levels.forEach((level, i) => {
    if (level.spp <= sppDev) {
      best = i;
    }
  });
  return best;
}

/** Data tiles of a level (`ceil(bins / bins_per_tile)`). */
export function levelTileCount(
  meta: Pick<PyramidMeta, "levels" | "bins_per_tile">,
  level: number,
): number {
  const bins = meta.levels[level]?.bins ?? 0;
  return Math.ceil(bins / meta.bins_per_tile);
}

/** Bins in data tile `tile` of `level` (the last tile may be short). */
export function tileBinCount(
  meta: Pick<PyramidMeta, "levels" | "bins_per_tile">,
  level: number,
  tile: number,
): number {
  const bins = meta.levels[level]?.bins ?? 0;
  const start = tile * meta.bins_per_tile;
  return Math.max(0, Math.min(meta.bins_per_tile, bins - start));
}

/**
 * Bins `[binStart, binEnd)` of a level that overlap frames
 * `[frameStart, frameEnd)`, clipped to the level.
 */
export function binRangeForFrames(
  meta: Pick<PyramidMeta, "levels">,
  level: number,
  frameStart: number,
  frameEnd: number,
): [number, number] {
  const lvl = meta.levels[level];
  if (!lvl || frameEnd <= frameStart) {
    return [0, 0];
  }
  const lo = Math.max(0, Math.floor(frameStart / lvl.spp));
  const hi = Math.min(lvl.bins, Math.ceil(frameEnd / lvl.spp));
  return hi > lo ? [lo, hi] : [lo, lo];
}

export function newEnvelope(cols: number): Envelope {
  return {
    cols,
    min: new Float32Array(cols),
    max: new Float32Array(cols),
    rms: new Float32Array(cols),
    has: new Uint8Array(cols),
  };
}

/**
 * Pyramid reduction (S6): column `c` covers frames
 * `[frameStart + c·sppDev, frameStart + (c+1)·sppDev)` and takes every bin
 * overlapping it: min of mins, max of maxes, `rms = sqrt(mean(rms²))`.
 * `bins` holds bins from `binStart`; a bin with `rms < 0` is missing.
 */
export function reduceEnvelope(
  bins: Int16Array,
  binStart: number,
  spp: number,
  frameStart: number,
  sppDev: number,
  cols: number,
): Envelope {
  const env = newEnvelope(cols);
  const count = Math.floor(bins.length / BIN_VALUES);
  for (let c = 0; c < cols; c++) {
    const f0 = frameStart + c * sppDev;
    const f1 = f0 + sppDev;
    const i0 = Math.max(binStart, Math.floor(f0 / spp));
    const i1 = Math.min(binStart + count, Math.ceil(f1 / spp));
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    let sumsq = 0;
    let n = 0;
    for (let i = i0; i < i1; i++) {
      const o = (i - binStart) * BIN_VALUES;
      const rms = bins[o + 2]!;
      if (rms < 0) {
        continue;
      }
      mn = Math.min(mn, bins[o]!);
      mx = Math.max(mx, bins[o + 1]!);
      sumsq += rms * rms;
      n += 1;
    }
    if (n > 0) {
      env.has[c] = 1;
      env.min[c] = mn / I16_SCALE;
      env.max[c] = mx / I16_SCALE;
      env.rms[c] = Math.sqrt(sumsq / n) / I16_SCALE;
    }
  }
  return env;
}

/**
 * PCM reduction (S6): the envelope of the piecewise-linear interpolant of the
 * per-frame `(min, max)` pairs, so adjacent columns share their edge values
 * and a line never breaks. Min/max take the samples inside the column plus
 * the interpolated values at both edges. RMS comes from the sample midpoints
 * when a column holds at least 4 frames, else 0.
 */
export function reducePcmEnvelope(
  pcm: Int16Array,
  pcmStart: number,
  frameStart: number,
  sppDev: number,
  cols: number,
): Envelope {
  const env = newEnvelope(cols);
  const frames = Math.floor(pcm.length / 2);
  if (frames === 0) {
    return env;
  }
  const first = pcmStart;
  const last = pcmStart + frames - 1;
  const at = (x: number, ch: 0 | 1): number => {
    const n = Math.min(Math.floor(x), last);
    const i = n - pcmStart;
    const v0 = pcm[i * 2 + ch]!;
    if (n >= last) {
      return v0;
    }
    const v1 = pcm[(i + 1) * 2 + ch]!;
    return v0 + (v1 - v0) * (x - n);
  };
  for (let c = 0; c < cols; c++) {
    const x0 = frameStart + c * sppDev;
    const x1 = x0 + sppDev;
    const e0 = Math.max(x0, first);
    const e1 = Math.min(x1, last);
    if (e1 < e0) {
      continue;
    }
    let mn = Math.min(at(e0, 0), at(e1, 0));
    let mx = Math.max(at(e0, 1), at(e1, 1));
    for (let n = Math.ceil(e0); n <= e1; n++) {
      const i = n - pcmStart;
      mn = Math.min(mn, pcm[i * 2]!);
      mx = Math.max(mx, pcm[i * 2 + 1]!);
    }
    env.has[c] = 1;
    env.min[c] = mn / I16_SCALE;
    env.max[c] = mx / I16_SCALE;
    if (sppDev >= 4) {
      let sumsq = 0;
      let count = 0;
      const n1 = Math.min(last + 1, Math.ceil(x1));
      for (let n = Math.max(first, Math.ceil(x0)); n < n1; n++) {
        const i = n - pcmStart;
        const mid = (pcm[i * 2]! + pcm[i * 2 + 1]!) / 2;
        sumsq += mid * mid;
        count += 1;
      }
      env.rms[c] = count > 0 ? Math.sqrt(sumsq / count) / I16_SCALE : 0;
    }
  }
  return env;
}
