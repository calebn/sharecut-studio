import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bucketPeaks } from "./peakBuckets";
import { PeakStrip } from "./waveStrip";

describe("bucketPeaks", () => {
  it("keeps the loudest peak of each run", () => {
    expect(bucketPeaks([0.1, 0.9, 0.3, 0.4, 0.2, 0.8], 3)).toEqual([
      0.9, 0.4, 0.8,
    ]);
  });

  it("splits an uneven run so every peak lands in exactly one bucket", () => {
    expect(bucketPeaks([0.1, 0.2, 0.3, 0.4, 0.5], 2)).toEqual([0.2, 0.5]);
    expect(bucketPeaks([0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9], 3)).toEqual([
      0.5, 0.1, 0.9,
    ]);
  });

  it("returns the peaks it was given when they already fit", () => {
    const peaks = [0.2, 0.4];
    expect(bucketPeaks(peaks, 2)).toBe(peaks);
    expect(bucketPeaks(peaks, 50)).toBe(peaks);
  });

  it("folds to one bar at least", () => {
    expect(bucketPeaks([0.2, 0.7, 0.4], 0)).toEqual([0.7]);
  });
});

describe("PeakStrip", () => {
  it("draws one bar per peak, as it always has, when it has no limit", () => {
    const { container } = render(<PeakStrip peaks={[0.2, 0.8, 0.5]} />);
    expect(container.querySelectorAll(".sys-wave-peak")).toHaveLength(3);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 3 1",
    );
  });

  it("draws no more bars than the limit and sizes the strip to them", () => {
    const peaks = Array.from({ length: 5000 }, (_, i) =>
      i === 2500 ? 1 : 0.1,
    );
    const { container } = render(<PeakStrip peaks={peaks} maxBars={100} />);
    const bars = [...container.querySelectorAll(".sys-wave-peak")];
    expect(bars).toHaveLength(100);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 100 1",
    );
    expect(bars[50].getAttribute("height")).toBe("1");
    expect(bars[0].getAttribute("height")).toBe("0.1");
  });
});
