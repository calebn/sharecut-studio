import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyramidMeta } from "../waveform/types";

const bins = vi.hoisted(() => ({ fill: (_i: number) => 0 as number }));

vi.mock("../waveform/pyramidStore", () => ({
  getBins: (_m: unknown, _level: number, binStart: number, count: number) => {
    const out = new Int16Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = bins.fill(binStart + i);
      out.set(v < 0 ? [0, 0, -1] : [-v, v, v], i * 3);
    }
    return out;
  },
}));

const { pyramidColumnPeaks, quietBandsFromPeaks, quietBandsInView } =
  await import("./quietWash");

describe("quietBandsFromPeaks", () => {
  it("keeps quiet runs of at least the minimum duration", () => {
    // 10 ms columns: 0.05 s quiet (too short), then 0.2 s quiet.
    const peaks = new Float32Array([
      0.5,
      0.01,
      0.01,
      0.01,
      0.01,
      0.01,
      0.5,
      ...new Array(20).fill(0.02),
      0.9,
    ]);
    expect(quietBandsFromPeaks(peaks, 10, 0.01)).toEqual([
      { startSec: expect.closeTo(10.07, 6), endSec: expect.closeTo(10.27, 6) },
    ]);
  });

  it("ends a run at missing data and at the end", () => {
    const peaks = new Float32Array([
      ...new Array(15).fill(0),
      Number.NaN,
      ...new Array(15).fill(0.01),
    ]);
    const bands = quietBandsFromPeaks(peaks, 0, 0.01);
    expect(bands).toHaveLength(2);
    expect(bands[0]!.endSec).toBeCloseTo(0.15, 6);
    expect(bands[1]!.endSec).toBeCloseTo(0.31, 6);
  });
});

describe("pyramidColumnPeaks", () => {
  const meta: PyramidMeta = {
    key: "q".repeat(20),
    sample_rate: 6400,
    channels: 1,
    total_frames: 6400 * 10,
    base_spp: 64,
    level_factor: 4,
    bins_per_tile: 4096,
    levels: [
      { spp: 64, bins: 1000 },
      { spp: 256, bins: 250 },
    ],
  };

  afterEach(() => {
    bins.fill = () => 0;
  });

  it("max-pools |min| and |max| per column, NaN where no data", () => {
    // Bin i peaks at i; bins 4..7 are missing.
    bins.fill = (i) => (i >= 4 && i < 8 ? -1 : i * 100);
    // 128 frames per column at level 0: two bins per column.
    const peaks = pyramidColumnPeaks(meta, 0, 128, 5);
    expect(peaks[0]).toBeCloseTo(100 / 32767, 6);
    expect(peaks[1]).toBeCloseTo(300 / 32767, 6);
    expect(Number.isNaN(peaks[2])).toBe(true);
    expect(peaks[4]).toBeCloseTo(900 / 32767, 6);
  });

  it("is all NaN past the media", () => {
    const peaks = pyramidColumnPeaks(meta, 6400 * 20, 128, 3);
    expect([...peaks].every(Number.isNaN)).toBe(true);
    expect(pyramidColumnPeaks(meta, 0, 128, 0)).toHaveLength(0);
  });
});

describe("quietBandsInView", () => {
  const meta: PyramidMeta = {
    key: "q".repeat(20),
    sample_rate: 6400,
    channels: 1,
    total_frames: 6400 * 10,
    base_spp: 64,
    level_factor: 4,
    bins_per_tile: 4096,
    levels: [
      { spp: 64, bins: 1000 },
      { spp: 256, bins: 250 },
    ],
  };

  afterEach(() => {
    bins.fill = () => 0;
  });

  // Level-0 bins are 10 ms: loud except a 1 s pause from 2 s to 3 s.
  const pause = (i: number) => (i >= 200 && i < 300 ? 0 : 20000);

  it("washes a long pause when the view shows only a sliver of it", () => {
    bins.fill = pause;
    // 20 ms of view at 48,000 px/s, inside the pause.
    expect(quietBandsInView(meta, 48000, [2.5, 2.52], [0, 10])).toEqual([
      { startSec: 2.5, endSec: 2.52 },
    ]);
  });

  it("clips a band to the view at its edge", () => {
    bins.fill = pause;
    const [band] = quietBandsInView(meta, 48000, [2.99, 3.01], [0, 10]);
    expect(band!.startSec).toBe(2.99);
    expect(band!.endSec).toBeCloseTo(3, 6);
  });

  it("still ignores a short dip, and quiet media outside the clip", () => {
    // A 50 ms dip: under QUIET_MIN_DURATION_SEC.
    bins.fill = (i) => (i >= 200 && i < 205 ? 0 : 20000);
    expect(quietBandsInView(meta, 48000, [2.01, 2.03], [0, 10])).toEqual([]);
    // The pause runs on past a clip that ends at 2.05 s: only 50 ms of it
    // is in the clip.
    bins.fill = pause;
    expect(quietBandsInView(meta, 48000, [2.01, 2.03], [0, 2.05])).toEqual([]);
  });

  it("is empty for an empty view", () => {
    expect(quietBandsInView(meta, 100, [1, 1], [0, 10])).toEqual([]);
  });
});
