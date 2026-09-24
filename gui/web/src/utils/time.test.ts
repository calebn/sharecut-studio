import { describe, expect, it } from "vitest";
import {
  formatTime,
  formatTimecodeCompact,
  formatTimecodePair,
  rulerTickTimes,
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

describe("rulerTickTimes", () => {
  it("never emits a tick past duration", () => {
    const ticks = rulerTickTimes(95, 10);
    expect(ticks.length).toBeGreaterThan(0);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(95);
  });

  it("does not force a duration end tick", () => {
    const ticks = rulerTickTimes(95, 10);
    expect(ticks).not.toContain(95);
  });

  it("includes zero", () => {
    expect(rulerTickTimes(60, 40)[0]).toBe(0);
  });

  it("ticks through empty canvas past a short session", () => {
    const canvasSec = 100;
    const ticks = rulerTickTimes(canvasSec, 10);
    expect(Math.max(...ticks)).toBeGreaterThan(60);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(canvasSec);
  });
});
