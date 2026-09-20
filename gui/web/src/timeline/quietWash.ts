import type { WaveformTile } from "../audio/waveformTiles";
import type { PeaksData } from "../types/project";
import { peakAmp, peakIndexRange } from "../utils/peaks";

export type QuietBand = {
  startSec: number;
  endSec: number;
};

const QUIET_AMP = 0.04;
const MIN_DURATION_SEC = 0.12;

function bandsFromAmps(
  samples: Array<{ t: number; amp: number }>,
): QuietBand[] {
  if (samples.length === 0) {
    return [];
  }
  const bands: QuietBand[] = [];
  let inQuiet = false;
  let start = 0;
  let lastT = samples[0]?.t ?? 0;
  for (const s of samples) {
    const quiet = s.amp <= QUIET_AMP;
    if (quiet && !inQuiet) {
      inQuiet = true;
      start = s.t;
    } else if (!quiet && inQuiet) {
      if (lastT - start >= MIN_DURATION_SEC) {
        bands.push({ startSec: start, endSec: lastT });
      }
      inQuiet = false;
    }
    lastT = s.t;
  }
  if (inQuiet) {
    const end = samples[samples.length - 1]?.t ?? lastT;
    if (end - start >= MIN_DURATION_SEC) {
      bands.push({ startSec: start, endSec: end });
    }
  }
  return bands;
}

/** Viewport quiet wash (amp heuristic); snap ticks come from EditService.waveform_snap_window. */
export function quietBandsFromPeaks(
  peaks: PeaksData | null,
  tiles: WaveformTile[],
  sourceStart: number,
  sourceEnd: number,
  cssWidth = 0,
): QuietBand[] {
  const samples: Array<{ t: number; amp: number }> = [];
  if (tiles.length > 0) {
    for (const tile of tiles) {
      const lo = Math.max(sourceStart, tile.startSec);
      const hi = Math.min(sourceEnd, tile.endSec);
      if (hi <= lo || tile.peaks.length === 0) {
        continue;
      }
      const span = tile.endSec - tile.startSec;
      const i0 = Math.floor(((lo - tile.startSec) / span) * tile.peaks.length);
      const i1 = Math.ceil(((hi - tile.startSec) / span) * tile.peaks.length);
      for (let i = i0; i < i1; i++) {
        const t = tile.startSec + (i / tile.peaks.length) * span;
        samples.push({ t, amp: peakAmp(tile.peaks[i] ?? 0) });
      }
    }
  } else if (peaks) {
    const [a, b] = peakIndexRange(peaks, sourceStart, sourceEnd);
    const n = Math.max(1, b - a);
    for (let i = a; i < b; i++) {
      const t = sourceStart + ((i - a) / n) * (sourceEnd - sourceStart);
      samples.push({ t, amp: peakAmp(peaks.peaks[i] ?? 0) });
    }
  }
  samples.sort((x, y) => x.t - y.t);
  const maxSamples = Math.max(8, Math.ceil(cssWidth));
  if (cssWidth > 0 && samples.length > maxSamples) {
    const step = samples.length / maxSamples;
    const subsampled: Array<{ t: number; amp: number }> = [];
    for (let i = 0; i < maxSamples; i++) {
      const s = samples[Math.min(samples.length - 1, Math.floor(i * step))];
      if (s) {
        subsampled.push(s);
      }
    }
    return bandsFromAmps(subsampled);
  }
  return bandsFromAmps(samples);
}
