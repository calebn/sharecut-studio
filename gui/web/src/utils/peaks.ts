import type { PeaksData } from "../types/project";

/** Browsers reject canvases past ~16k–32k on a side; stay well under with DPR. */
export const MAX_PEAKS_CANVAS_CSS_PX = 8192;
export const WAVEFORM_OVERSCAN_PX = 512;

export function peakAmp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value > 1 ? value / 255 : value;
}

export function coercePeaksPayload(raw: PeaksData): PeaksData {
  const arr = raw.peaks;
  if (arr instanceof Uint8Array) {
    return raw;
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return raw;
  }
  const encoding = raw.encoding;
  if (encoding === "uint8" || arr.some((v) => v > 1)) {
    return {
      ...raw,
      encoding: "uint8",
      peaks: Uint8Array.from(arr),
    };
  }
  return raw;
}

/**
 * Peak-bin index range covering [sourceStart, sourceEnd) in the full-file peaks.
 * peaks[i] covers samples [i * spp, (i+1) * spp) ≈ time i * spp / sampleRate.
 */
export function peakIndexRange(
  peaks: PeaksData,
  sourceStart: number,
  sourceEnd: number,
): [number, number] {
  const { sample_rate: sampleRate, samples_per_pixel: spp, peaks: arr } = peaks;
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(spp) ||
    spp <= 0 ||
    arr.length === 0
  ) {
    return [0, 0];
  }
  const secPerBin = spp / sampleRate;
  const i0 = Math.max(0, Math.floor(sourceStart / secPerBin));
  const i1 = Math.min(arr.length, Math.ceil(sourceEnd / secPerBin));
  if (i1 <= i0) {
    return [Math.min(i0, arr.length), Math.min(i0, arr.length)];
  }
  return [i0, i1];
}

/**
 * Backing-store CSS width for a clip waveform: viewport + overscan, never the
 * full hour-scale clip width.
 */
export function peaksCanvasCssWidth(
  clipWidthCss: number,
  dpr = 1,
  maxCss = MAX_PEAKS_CANVAS_CSS_PX,
  viewportWidthCss = 0,
): number {
  if (!Number.isFinite(clipWidthCss) || clipWidthCss <= 0) {
    return 0;
  }
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const maxForDpr = Math.floor(maxCss / safeDpr);
  const viewportCap =
    viewportWidthCss > 0
      ? viewportWidthCss + 2 * WAVEFORM_OVERSCAN_PX
      : clipWidthCss;
  return Math.max(
    1,
    Math.min(
      Math.ceil(clipWidthCss),
      Math.ceil(viewportCap),
      maxForDpr,
      maxCss,
    ),
  );
}
