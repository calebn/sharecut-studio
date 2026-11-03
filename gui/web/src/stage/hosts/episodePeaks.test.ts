import { describe, expect, it } from "vitest";
import { binPeaks, mixPeaks } from "./episodePeaks";

const bins = (...maxes: number[]) =>
  Int16Array.from(maxes.flatMap((m) => [-m / 2, m, m / 4]));

describe("binPeaks", () => {
  it("takes the largest absolute value per column, scaled to 0..1", () => {
    // 4 bins of 1 s each over 2 s: two bins per column.
    const peaks = binPeaks(
      Int16Array.from([-32767, 100, 0, 0, 50, 0, 0, 16384, 0, 10, 20, 0]),
      { sample_rate: 100 },
      100,
      4,
      2,
    );
    expect(peaks).toEqual([1, 16384 / 32767]);
  });

  it("leaves time past the media at 0", () => {
    expect(binPeaks(bins(32767), { sample_rate: 10 }, 10, 4, 4)).toEqual([
      1, 0, 0, 0,
    ]);
  });

  it("ignores bins beyond the span", () => {
    const peaks = binPeaks(bins(1000, 2000, 3000), { sample_rate: 1 }, 1, 2, 2);
    expect(peaks[0]).toBeCloseTo(1000 / 32767);
    expect(peaks[1]).toBeCloseTo(2000 / 32767);
  });

  it("is all zeros for no bins or no length", () => {
    expect(binPeaks(new Int16Array(), { sample_rate: 10 }, 10, 4, 3)).toEqual([
      0, 0, 0,
    ]);
    expect(binPeaks(bins(5), { sample_rate: 10 }, 10, 0, 3)).toEqual([0, 0, 0]);
  });
});

describe("mixPeaks", () => {
  it("takes the loudest set per column and scales the largest to 1", () => {
    expect(
      mixPeaks([
        [0.1, 0.4, 0],
        [0.2, 0.1, 0],
      ]),
    ).toEqual([0.5, 1, 0]);
  });

  it("is empty without sets or when silent", () => {
    expect(mixPeaks([])).toEqual([]);
    expect(mixPeaks([[0, 0]])).toEqual([]);
  });
});
