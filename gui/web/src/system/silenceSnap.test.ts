import { describe, expect, it } from "vitest";
import { clampRange, snapToSilence } from "./silenceSnap";

const loud = (n: number) => Array.from({ length: n }, () => 0.8);

describe("snapToSilence", () => {
  const options = { windowSeconds: 12 };

  it("moves to the nearest quiet peak within reach", () => {
    const peaks = loud(120);
    peaks[50] = 0.02;
    peaks[53] = 0.02;
    expect(snapToSilence(5.2, peaks, options)).toBeCloseTo(5.05, 5);
    expect(snapToSilence(5.28, peaks, options)).toBeCloseTo(5.35, 5);
  });

  it("stays put when no quiet peak is in reach", () => {
    const peaks = loud(120);
    peaks[10] = 0;
    expect(snapToSilence(6, peaks, options)).toBe(6);
  });

  it("stays put without peaks", () => {
    expect(snapToSilence(3, [], options)).toBe(3);
  });

  it("does not read past either end of the peaks", () => {
    const peaks = loud(120);
    peaks[0] = 0;
    peaks[119] = 0;
    expect(snapToSilence(0.05, peaks, options)).toBeCloseTo(0.05, 5);
    expect(snapToSilence(11.9, peaks, options)).toBeCloseTo(11.95, 5);
  });
});

describe("clampRange", () => {
  const window = { start: 0, end: 12 };
  it("keeps the start inside the window and before the end", () => {
    expect(clampRange({ start: -2, end: 6 }, "start", window).start).toBe(0);
    expect(clampRange({ start: 7, end: 6 }, "start", window).start).toBeCloseTo(
      5.9,
    );
  });
  it("keeps the end inside the window and after the start", () => {
    expect(clampRange({ start: 4, end: 20 }, "end", window).end).toBe(12);
    expect(clampRange({ start: 4, end: 3 }, "end", window).end).toBeCloseTo(
      4.1,
    );
  });
});
