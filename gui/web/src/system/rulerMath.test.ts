import { describe, expect, it } from "vitest";
import { rulerStep, rulerTicks, timeAtX, xAtTime } from "./rulerMath";

describe("rulerMath", () => {
  it("converts between pixels and seconds of a window", () => {
    expect(timeAtX(100, 604, 40)).toBe(606.5);
    expect(xAtTime(606.5, 604, 40)).toBe(100);
  });

  it("picks the smallest nice step whose ticks are 64 px apart", () => {
    expect(
      [400, 100, 40, 12, 1, 0.5, 0.1].map((pps) => rulerStep(pps, 100)),
    ).toEqual([0.2, 1, 2, 10, 120, 300, 900]);
  });

  it("widens the step when the labels of a long episode are wider than 64 px", () => {
    expect(rulerStep(30, 36000)).toBe(5);
    expect(rulerStep(30, 100)).toBe(5);
    expect(rulerStep(640, 36000)).toBe(0.2);
    expect(rulerStep(640, 100)).toBe(0.1);
  });

  it("never lets two labels sit closer than 64 px at any zoom", () => {
    for (const pps of [0.05, 0.3, 1, 7, 33, 90, 250, 1000, 9000]) {
      const step = rulerStep(pps, 5000);
      const ticks = rulerTicks(1000, pps, 600, step);
      const gaps = ticks.slice(1).map((tick, i) => tick.x - (ticks[i]?.x ?? 0));
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(63.999);
    }
  });

  it("keeps labels 64 px apart for a 10 hour episode fitted into 360 px", () => {
    const pps = 360 / 36000;
    const step = rulerStep(pps, 36000);
    expect(step).toBe(7200);
    const ticks = rulerTicks(0, pps, 360, step, 36000);
    expect(ticks.map((t) => t.label)).toEqual([
      "0:00",
      "2:00:00",
      "4:00:00",
      "6:00:00",
      "8:00:00",
      "10:00:00",
    ]);
    expect(ticks.map((t) => t.x)).toEqual([0, 72, 144, 216, 288, 360]);
  });

  it("lists ticks as index times step, from one label's width before the window", () => {
    const ticks = rulerTicks(604, 40, 360, 2);
    expect(ticks.map((t) => [t.time, t.x, t.label])).toEqual([
      [604, 0, "10:04"],
      [606, 80, "10:06"],
      [608, 160, "10:08"],
      [610, 240, "10:10"],
      [612, 320, "10:12"],
    ]);
    expect(rulerTicks(605, 40, 360, 2)[0]).toEqual({
      time: 604,
      x: -40,
      label: "10:04",
    });
    expect(rulerTicks(606, 40, 360, 2)[0]?.time).toBe(606);
  });

  it("does not drift at a deep zoom", () => {
    const ticks = rulerTicks(12.0003, 20000, 400, 0.0005);
    expect(ticks.slice(0, 3).map((t) => t.label)).toEqual([
      "0:11.9975",
      "0:11.9980",
      "0:11.9985",
    ]);
  });

  it("stops at the episode's end and for empty input", () => {
    expect(rulerTicks(0, 1, 360, 60, 120).map((t) => t.time)).toEqual([
      0, 60, 120,
    ]);
    expect(rulerTicks(0, 1, 0, 60)).toEqual([]);
    expect(rulerTicks(0, 0, 360, 60)).toEqual([]);
    expect(rulerTicks(0, 1, 360, 0)).toEqual([]);
  });
});
