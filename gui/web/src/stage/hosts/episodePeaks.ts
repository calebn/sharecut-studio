import { I16_SCALE } from "../../waveform/pyramidMath";
import type { PyramidMeta } from "../../waveform/types";

/** Columns of the whole-episode peaks the clip trim strip slices from. */
export const EPISODE_PEAK_COUNT = 1024;

/**
 * Peaks (0..1) of one stem over `totalSec`: `bins` are the `min, max, rms`
 * triples of its coarsest level, and each column takes the largest absolute
 * bin value that starts inside it. Time past the stem's end stays 0.
 */
export function binPeaks(
  bins: Int16Array,
  meta: Pick<PyramidMeta, "sample_rate">,
  spp: number,
  totalSec: number,
  count: number = EPISODE_PEAK_COUNT,
): number[] {
  const peaks = new Array<number>(count).fill(0);
  if (totalSec <= 0 || count <= 0 || meta.sample_rate <= 0) return peaks;
  const secPerBin = spp / meta.sample_rate;
  for (let i = 0; i + 1 < bins.length; i += 3) {
    const col = Math.floor(((i / 3) * secPerBin * count) / totalSec);
    if (col >= count) break;
    const value = Math.max(Math.abs(bins[i]!), Math.abs(bins[i + 1]!));
    if (value > peaks[col]!) peaks[col] = value;
  }
  return peaks.map((v) => Math.min(1, v / I16_SCALE));
}

/** The loudest of several same-length peak sets, scaled so the largest is 1; empty when silent. */
export function mixPeaks(sets: readonly (readonly number[])[]): number[] {
  const first = sets[0];
  if (!first) return [];
  const mixed = first.map((_, i) => Math.max(...sets.map((s) => s[i] ?? 0)));
  const top = Math.max(...mixed);
  return top > 0 ? mixed.map((v) => v / top) : [];
}
