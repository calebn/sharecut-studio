import {
  QUIET_AMP,
  QUIET_MIN_DURATION_SEC,
} from "../utils/timelineZoom.generated";
import { reduceEnvelope } from "../waveform/pyramidMath";
import { getBins } from "../waveform/pyramidStore";
import { drawLevel } from "../waveform/renderTiles";
import type { PyramidMeta } from "../waveform/types";

/** A quiet stretch of media, in media seconds. */
export type QuietBand = {
  startSec: number;
  endSec: number;
};

/**
 * Quiet bands from per-column peaks (0..1; NaN where no data is loaded):
 * runs at or under `quiet_amp` that last `quiet_min_duration_sec`. Column
 * `i` starts at `startSec + i·secPerCol`. Missing data ends a run.
 */
export function quietBandsFromPeaks(
  peaks: Float32Array,
  startSec: number,
  secPerCol: number,
): QuietBand[] {
  const bands: QuietBand[] = [];
  let runStart = -1;
  const close = (end: number) => {
    const s = startSec + runStart * secPerCol;
    const e = startSec + end * secPerCol;
    if (e - s >= QUIET_MIN_DURATION_SEC) {
      bands.push({ startSec: s, endSec: e });
    }
    runStart = -1;
  };
  for (let i = 0; i < peaks.length; i++) {
    const quiet = peaks[i]! <= QUIET_AMP;
    if (quiet && runStart < 0) {
      runStart = i;
    } else if (!quiet && runStart >= 0) {
      close(i);
    }
  }
  if (runStart >= 0) {
    close(peaks.length);
  }
  return bands;
}

/**
 * Max-pooled column peaks, `max(|min|, |max|)`, of `cols` columns of
 * `framesPerCol` media frames from `frameStart`, from whatever pyramid data
 * is loaded (NaN where none is).
 */
export function pyramidColumnPeaks(
  meta: PyramidMeta,
  frameStart: number,
  framesPerCol: number,
  cols: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, cols)).fill(Number.NaN);
  const level = drawLevel(meta, framesPerCol);
  const spp = meta.levels[level]?.spp;
  if (!spp || cols <= 0) {
    return out;
  }
  const binStart = Math.max(0, Math.floor(frameStart / spp));
  const binEnd = Math.min(
    meta.levels[level]!.bins,
    Math.ceil((frameStart + framesPerCol * cols) / spp),
  );
  if (binEnd <= binStart) {
    return out;
  }
  const bins = getBins(meta, level, binStart, binEnd - binStart);
  const env = reduceEnvelope(
    bins,
    binStart,
    spp,
    frameStart,
    framesPerCol,
    cols,
  );
  for (let c = 0; c < cols; c++) {
    if (env.has[c]) {
      out[c] = Math.max(Math.abs(env.min[c]!), Math.abs(env.max[c]!));
    }
  }
  return out;
}

/**
 * Quiet bands shown in the view `[viewStartSec, viewEndSec]`, judged over
 * the stretch around it (clamped to `[limitStartSec, limitEndSec]`, the
 * clip's media). A quiet run counts by its whole length, not the sliver in
 * view, so the wash stays when a deep zoom shows only milliseconds of a long
 * pause. Columns are one CSS px, but never finer than a level-0 bin.
 */
export function quietBandsInView(
  meta: PyramidMeta,
  zoom: number,
  view: readonly [number, number],
  limit: readonly [number, number],
): QuietBand[] {
  const [viewStart, viewEnd] = view;
  const base = meta.levels[0]?.spp;
  if (!base || !(zoom > 0) || !(viewEnd > viewStart)) {
    return [];
  }
  const secPerCol = Math.max(1 / zoom, base / meta.sample_rate);
  const start = Math.max(limit[0], viewStart - QUIET_MIN_DURATION_SEC);
  const end = Math.min(limit[1], viewEnd + QUIET_MIN_DURATION_SEC);
  const cols = Math.ceil((end - start) / secPerCol);
  const peaks = pyramidColumnPeaks(
    meta,
    start * meta.sample_rate,
    secPerCol * meta.sample_rate,
    cols,
  );
  return quietBandsFromPeaks(peaks, start, secPerCol)
    .map((b) => ({
      startSec: Math.max(b.startSec, viewStart),
      endSec: Math.min(b.endSec, viewEnd),
    }))
    .filter((b) => b.endSec > b.startSec);
}
