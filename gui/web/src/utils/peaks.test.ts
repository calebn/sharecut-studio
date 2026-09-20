import { describe, expect, it } from "vitest";
import type { PeaksData } from "../types/project";
import {
  MAX_PEAKS_CANVAS_CSS_PX,
  peakIndexRange,
  peaksCanvasCssWidth,
} from "./peaks";

function peaks(n: number, spp = 512, sampleRate = 48000): PeaksData {
  return {
    peaks: Array.from({ length: n }, (_, i) => i / n),
    samples_per_pixel: spp,
    sample_rate: sampleRate,
  };
}

describe("peakIndexRange", () => {
  // secPerBin = 512/48000 ≈ 0.010666...
  const data = peaks(1000);

  it("maps from source zero", () => {
    const [i0, i1] = peakIndexRange(data, 0, 0.021333);
    expect(i0).toBe(0);
    expect(i1).toBe(2);
  });

  it("maps a mid-file window", () => {
    const secPerBin = 512 / 48000;
    const [i0, i1] = peakIndexRange(data, 100 * secPerBin, 110 * secPerBin);
    expect(i0).toBe(100);
    expect(i1).toBe(110);
  });

  it("clamps past end of peaks", () => {
    const [i0, i1] = peakIndexRange(data, 20, 30);
    expect(i0).toBeGreaterThan(0);
    expect(i1).toBe(1000);
  });

  it("handles empty / invalid peaks", () => {
    expect(
      peakIndexRange(
        { peaks: [], samples_per_pixel: 512, sample_rate: 48000 },
        0,
        1,
      ),
    ).toEqual([0, 0]);
    expect(peakIndexRange(peaks(10), 5, 5)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    const [a, b] = peakIndexRange(peaks(10), 5, 5);
    expect(b).toBe(a);
  });
});

describe("peaksCanvasCssWidth", () => {
  it("passes through modest widths", () => {
    expect(peaksCanvasCssWidth(400, 2)).toBe(400);
  });

  it("caps hour-scale clips so width*dpr stays under the limit", () => {
    const huge = 3772 * 40; // ~150k CSS px at 40px/s
    const capped = peaksCanvasCssWidth(huge, 2, MAX_PEAKS_CANVAS_CSS_PX, 800);
    expect(capped).toBeLessThanOrEqual(800 + 2 * 512);
    expect(capped).toBeGreaterThan(0);
  });

  it("returns 0 for non-finite widths", () => {
    expect(peaksCanvasCssWidth(Number.NaN, 2)).toBe(0);
    expect(peaksCanvasCssWidth(-10, 2)).toBe(0);
  });
});
