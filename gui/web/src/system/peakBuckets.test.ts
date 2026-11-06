import { describe, expect, it } from "vitest";
import { bucketPeaks } from "./peakBuckets";

describe("bucketPeaks", () => {
  it("returns peaks that already fit as they are", () => {
    const peaks = [0.1, 0.5, 0.2];
    expect(bucketPeaks(peaks, 3)).toBe(peaks);
  });

  it("folds each run into its loudest value", () => {
    expect(bucketPeaks([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
  });

  it("rounds a fractional limit down and never goes below one bucket", () => {
    expect(bucketPeaks([0.1, 0.9, 0.2, 0.3], 2.9)).toEqual([0.9, 0.3]);
    expect(bucketPeaks([0.1, 0.9, 0.2], 0)).toEqual([0.9]);
  });

  it("keeps one bucket for a limit that is not a number, rather than drawing nothing", () => {
    expect(bucketPeaks([0.1, 0.9, 0.2], Number.NaN)).toEqual([0.9]);
  });

  it("returns peaks as they are when the limit is unbounded", () => {
    const peaks = [0.1, 0.9, 0.2];
    expect(bucketPeaks(peaks, Number.POSITIVE_INFINITY)).toBe(peaks);
  });

  it("returns an empty list for no peaks", () => {
    expect(bucketPeaks([], 4)).toEqual([]);
  });
});
