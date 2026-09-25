import { describe, expect, it } from "vitest";
import {
  BIN_VALUES,
  binRangeForFrames,
  I16_SCALE,
  levelFor,
  levelTileCount,
  reduceEnvelope,
  reducePcmEnvelope,
  tileBinCount,
} from "./pyramidMath";

/** Deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const meta = {
  bins_per_tile: 4096,
  levels: [
    { spp: 64, bins: 10000 },
    { spp: 256, bins: 2500 },
    { spp: 1024, bins: 625 },
  ],
};

describe("levelFor", () => {
  it("is the largest level whose spp fits a column, or -1", () => {
    for (const spp of [1, 10, 63.9, 64, 100, 255, 256, 1000, 1024, 1e6]) {
      let brute = -1;
      for (let i = 0; i < meta.levels.length; i++) {
        if (meta.levels[i]!.spp <= spp) {
          brute = i;
        }
      }
      expect(levelFor(meta, spp)).toBe(brute);
    }
  });
});

describe("level tiles and bin ranges", () => {
  it("counts data tiles and the short last tile", () => {
    expect(levelTileCount(meta, 0)).toBe(3);
    expect(tileBinCount(meta, 0, 0)).toBe(4096);
    expect(tileBinCount(meta, 0, 2)).toBe(10000 - 8192);
    expect(tileBinCount(meta, 0, 3)).toBe(0);
    expect(levelTileCount(meta, 9)).toBe(0);
  });

  it("clips bin ranges to the level", () => {
    expect(binRangeForFrames(meta, 0, 100, 300)).toEqual([1, 5]);
    expect(binRangeForFrames(meta, 0, -500, 64)).toEqual([0, 1]);
    expect(binRangeForFrames(meta, 2, 0, 1e9)).toEqual([0, 625]);
    expect(binRangeForFrames(meta, 0, 5, 5)).toEqual([0, 0]);
    expect(binRangeForFrames(meta, 7, 0, 10)).toEqual([0, 0]);
  });
});

function randomBins(n: number, rand: () => number, missing = 0): Int16Array {
  const bins = new Int16Array(n * BIN_VALUES);
  for (let i = 0; i < n; i++) {
    const a = Math.round((rand() * 2 - 1) * I16_SCALE);
    const b = Math.round((rand() * 2 - 1) * I16_SCALE);
    bins[i * 3] = Math.min(a, b);
    bins[i * 3 + 1] = Math.max(a, b);
    bins[i * 3 + 2] = rand() < missing ? -1 : Math.round(rand() * I16_SCALE);
  }
  return bins;
}

describe("reduceEnvelope", () => {
  it.each([
    [1, 64, 0, 64, 40],
    [2, 64, 37.5, 150.25, 60],
    [3, 256, 1000, 256, 30],
    [4, 64, -300, 97.3, 50],
    [5, 1024, 5000, 3000.7, 20],
  ])(
    "matches brute force on random bins (seed %s)",
    (seed, spp, frameStart, sppDev, cols) => {
      const rand = rng(seed);
      const binStart = 3;
      const n = 200;
      const bins = randomBins(n, rand, 0.1);
      const env = reduceEnvelope(bins, binStart, spp, frameStart, sppDev, cols);
      for (let c = 0; c < cols; c++) {
        const f0 = frameStart + c * sppDev;
        const f1 = f0 + sppDev;
        let mn = Infinity;
        let mx = -Infinity;
        let sumsq = 0;
        let k = 0;
        for (let j = 0; j < n; j++) {
          const i = binStart + j;
          const overlaps = i * spp < f1 && (i + 1) * spp > f0;
          if (!overlaps || bins[j * 3 + 2]! < 0) {
            continue;
          }
          mn = Math.min(mn, bins[j * 3]!);
          mx = Math.max(mx, bins[j * 3 + 1]!);
          sumsq += bins[j * 3 + 2]! ** 2;
          k += 1;
        }
        expect(env.has[c]).toBe(k > 0 ? 1 : 0);
        if (k > 0) {
          expect(env.min[c]).toBeCloseTo(mn / I16_SCALE, 6);
          expect(env.max[c]).toBeCloseTo(mx / I16_SCALE, 6);
          expect(env.rms[c]).toBeCloseTo(Math.sqrt(sumsq / k) / I16_SCALE, 6);
        }
      }
    },
  );
});

function randomPcm(n: number, rand: () => number): Int16Array {
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.round((rand() * 2 - 1) * I16_SCALE);
    const b = Math.round((rand() * 2 - 1) * I16_SCALE);
    pcm[i * 2] = Math.min(a, b);
    pcm[i * 2 + 1] = Math.max(a, b);
  }
  return pcm;
}

describe("reducePcmEnvelope", () => {
  it.each([
    [11, 0.37, 100.2, 40],
    [12, 1, 99, 60],
    [13, 2.5, 90.75, 50],
    [14, 6.3, 80, 30],
    [15, 0.1, 150.05, 20],
  ])(
    "matches the interpolant's envelope by brute force (seed %s)",
    (seed, sppDev, frameStart, cols) => {
      const rand = rng(seed);
      const pcmStart = 100;
      const n = 120;
      const pcm = randomPcm(n, rand);
      const last = pcmStart + n - 1;
      const interp = (x: number, ch: number) => {
        const i = Math.min(Math.floor(x), last) - pcmStart;
        if (i + pcmStart >= last) {
          return pcm[i * 2 + ch]!;
        }
        const t = x - (i + pcmStart);
        return pcm[i * 2 + ch]! * (1 - t) + pcm[(i + 1) * 2 + ch]! * t;
      };
      const env = reducePcmEnvelope(pcm, pcmStart, frameStart, sppDev, cols);
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(frameStart + c * sppDev, pcmStart);
        const x1 = Math.min(frameStart + (c + 1) * sppDev, last);
        if (x1 < x0) {
          expect(env.has[c]).toBe(0);
          continue;
        }
        // Dense samples plus every vertex: the exact extremes of a
        // piecewise-linear function on [x0, x1].
        const xs = [x0, x1];
        for (let x = Math.ceil(x0); x <= x1; x++) {
          xs.push(x);
        }
        for (let k = 0; k < 40; k++) {
          xs.push(x0 + (x1 - x0) * rand());
        }
        const mn = Math.min(...xs.map((x) => interp(x, 0)));
        const mx = Math.max(...xs.map((x) => interp(x, 1)));
        expect(env.has[c]).toBe(1);
        expect(env.min[c]).toBeCloseTo(mn / I16_SCALE, 5);
        expect(env.max[c]).toBeCloseTo(mx / I16_SCALE, 5);
      }
    },
  );

  it("takes RMS from sample midpoints only at 4+ frames per column", () => {
    const pcm = new Int16Array([-100, 300, -100, 300, -100, 300, -100, 300]);
    const wide = reducePcmEnvelope(pcm, 0, 0, 4, 1);
    expect(wide.rms[0]).toBeCloseTo(100 / I16_SCALE, 6);
    const narrow = reducePcmEnvelope(pcm, 0, 0, 2, 2);
    expect(narrow.rms[0]).toBe(0);
    expect(narrow.has[1]).toBe(1);
  });

  it("is empty without samples", () => {
    const env = reducePcmEnvelope(new Int16Array(0), 0, 0, 1, 3);
    expect([...env.has]).toEqual([0, 0, 0]);
  });
});
