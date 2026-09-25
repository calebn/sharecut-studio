import { describe, expect, it } from "vitest";
import {
  formatRulerTime,
  formatTime,
  formatTimecodeCompact,
  formatTimecodePair,
  niceTimeStep,
  transportTimecode,
} from "./time";

describe("formatTimecodePair", () => {
  it("keeps a fixed layout under one hour", () => {
    const a = formatTimecodePair(0, 3500);
    const b = formatTimecodePair(1234.567, 3500);
    expect(a.length).toBe(b.length);
    expect(a).toBe("00:00.000 / 58:20.000");
    expect(b).toBe("20:34.567 / 58:20.000");
  });

  it("forces hours on both sides for long episodes", () => {
    const a = formatTimecodePair(0, 3772);
    const b = formatTimecodePair(1200.5, 3772);
    expect(a.length).toBe(b.length);
    expect(a).toBe("00:00:00.000 / 01:02:52.000");
    expect(b).toBe("00:20:00.500 / 01:02:52.000");
  });
});

describe("formatTimecodeCompact", () => {
  it("shows playhead only and respects hour layout", () => {
    expect(formatTimecodeCompact(65, 3500)).toBe("01:05.000");
    expect(formatTimecodeCompact(65, 3772)).toBe("00:01:05.000");
  });
});

describe("transportTimecode", () => {
  it("returns the current, total and tooltip in one digit layout", () => {
    expect(transportTimecode(12.48, 60)).toEqual({
      current: "00:12.480",
      total: "01:00.000",
      title: "00:12.480 / 01:00.000",
    });
    expect(transportTimecode(5, 3600)).toEqual({
      current: "00:00:05.000",
      total: "01:00:00.000",
      title: "00:00:05.000 / 01:00:00.000",
    });
  });
});

describe("formatTime", () => {
  it("pads hours when forced", () => {
    expect(formatTime(65, { forceHours: true })).toBe("00:01:05.000");
  });
});

describe("niceTimeStep", () => {
  it.each([
    [0.05, 1800],
    [10, 10],
    [40, 2],
    [100, 1],
    [1000, 0.1],
    [48000, 0.002],
    [1e6, 0.0001],
  ])("at %s px/s steps by %s s (labels ≥ 70 px apart)", (zoom, step) => {
    expect(niceTimeStep(zoom)).toBe(step);
    expect(step * zoom).toBeGreaterThanOrEqual(70);
  });

  it("stops at an hour", () => {
    expect(niceTimeStep(0.001)).toBe(3600);
  });
});

describe("formatRulerTime", () => {
  it.each([
    [0, 2, "0:00"],
    [65, 5, "1:05"],
    [1.25, 0.05, "0:01.25"],
    [1.2346, 0.002, "0:01.235"],
    [1.23456, 0.0005, "0:01.2346"],
    [59.9999, 0.001, "1:00.000"],
    [3725.4, 60, "1:02:05"],
    [12.4, 1, "0:12"],
    [2.5, 0.5, "0:02.5"],
    [12, 0.0001, "0:12.0000"],
  ])("formats %s s at a %s s step as %s", (sec, step, label) => {
    expect(formatRulerTime(sec, step)).toBe(label);
  });

  it.each([
    [59.68, 1, "0:59"],
    [12.7, 1, "0:12"],
    [59.68, 0.5, "0:59.6"],
    [0.3, 0.1, "0:00.3"],
    [3725.99, 60, "1:02:05"],
  ])(
    "floors %s s at a %s s step to %s for a position readout",
    (sec, step, label) => {
      expect(formatRulerTime(sec, step, "floor")).toBe(label);
    },
  );
});
