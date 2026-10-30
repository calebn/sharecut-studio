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

  it("keeps the end label of a 10 hour episode fitted into 360 px and drops the one it would sit on", () => {
    const pps = 360 / 36000;
    const step = rulerStep(pps, 36000);
    expect(step).toBe(7200);
    const ticks = rulerTicks(0, pps, 360, step, 36000);
    expect(ticks.map((t) => t.label)).toEqual([
      "0:00",
      "2:00:00",
      "4:00:00",
      "6:00:00",
      "",
      "10:00:00",
    ]);
    expect(ticks.at(-1)?.align).toBe("end");
    expect(ticks.map((t) => t.x)).toEqual([0, 72, 144, 216, 288, 360]);
  });

  it("does not end-align a label that has no room to its left", () => {
    for (const width of [40, 60]) {
      const ticks = rulerTicks(7, 10, width, 10, 100);
      const tick = ticks.find((t) => t.time === 10);
      expect(tick?.x).toBe(30);
      expect(tick?.label).toBe("");
    }
    const roomy = rulerTicks(8, 20, 60, 10, 100).find((t) => t.time === 10);
    expect([roomy?.x, roomy?.align, roomy?.label]).toEqual([40, "end", "0:10"]);
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
      align: "start",
    });
    expect(rulerTicks(606, 40, 360, 2)[0]?.time).toBe(606);
  });

  it("right-aligns a label that would pass the window's right edge", () => {
    const ticks = rulerTicks(0, 12, 360, 10, 36);
    expect(ticks.map((t) => [t.time, t.x, t.label, t.align])).toEqual([
      [0, 0, "0:00", "start"],
      [10, 120, "0:10", "start"],
      [20, 240, "0:20", "start"],
      [30, 360, "0:30", "end"],
    ]);
    expect(rulerTicks(0, 12, 280, 10, 36).at(-1)?.align).toBe("start");
    expect(rulerTicks(0, 12, 270, 10, 36).at(-1)?.align).toBe("end");
  });

  it("drops the label before the episode's end when the end label would sit on it, and keeps the end", () => {
    const ticks = rulerTicks(0, 18, 162, 3, 9);
    expect(ticks.map((t) => [t.x, t.label, t.align])).toEqual([
      [0, "0:00", "start"],
      [54, "0:03", "start"],
      [108, "", "start"],
      [162, "0:09", "end"],
    ]);
  });

  it("drops a right-aligned label that is not the episode's end rather than the one before it", () => {
    const ticks = rulerTicks(0, 18, 162, 3, 100);
    expect(ticks.map((t) => [t.x, t.label, t.align])).toEqual([
      [0, "0:00", "start"],
      [54, "0:03", "start"],
      [108, "0:06", "start"],
      [162, "", "end"],
    ]);
  });

  it("does not drift at a deep zoom", () => {
    const step = rulerStep(20000, 12.02);
    expect(step).toBe(0.005);
    const ticks = rulerTicks(12.0003, 20000, 400, step);
    expect(ticks.slice(0, 3).map((t) => [t.time, t.label])).toEqual(
      [
        [2400, "0:12.000"],
        [2401, "0:12.005"],
        [2402, "0:12.010"],
      ].map(([index, label]) => [(index as number) * step, label]),
    );
  });

  it("stops at the episode's end and for empty input", () => {
    expect(rulerTicks(0, 1, 360, 60, 120).map((t) => t.time)).toEqual([
      0, 60, 120,
    ]);
    expect(rulerTicks(0, 1, 0, 60)).toEqual([]);
    expect(rulerTicks(0, 0, 360, 60)).toEqual([]);
    expect(rulerTicks(0, 1, 360, 0)).toEqual([]);
  });

  it("never leaves two labels overlapping at a phone's widths, root fonts or zooms, and always keeps the end label", () => {
    const extent = (
      tick: ReturnType<typeof rulerTicks>[number],
      rem: number,
    ) => {
      const w = tick.label.length * 0.4125 * rem + 0.3125 * rem;
      return tick.align === "end" ? [tick.x - w, tick.x] : [tick.x, tick.x + w];
    };
    let ends = 0;
    for (const rem of [16, 20, 24, 32]) {
      for (const width of [256, 296, 329, 1248]) {
        for (const duration of [60, 600, 3600, 36000]) {
          const pps = width / duration;
          const step = rulerStep(pps, duration, rem);
          const ticks = rulerTicks(0, pps, width, step, duration, rem);
          const shown = ticks.filter((tick) => tick.label !== "");
          const where = `rem ${rem}, width ${width}, duration ${duration}`;
          for (let i = 1; i < shown.length; i++) {
            const [, right] = extent(shown[i - 1]!, rem) as [number, number];
            const [left] = extent(shown[i]!, rem) as [number, number];
            expect(left, where).toBeGreaterThanOrEqual(right);
          }
          const end = ticks.at(-1)!;
          if (end.time === duration) {
            expect(end.label, where).not.toBe("");
            ends++;
          }
        }
      }
    }
    expect(ends).toBeGreaterThan(20);
  });

  it("leaves a root font's worth more room between labels, in rem not px", () => {
    expect(rulerStep(10, 600, 32)).toBeGreaterThan(rulerStep(10, 600, 16));
    const ticks = rulerTicks(0, 10, 600, rulerStep(10, 600, 32), 600, 32);
    const gaps = ticks.slice(1).map((tick, i) => tick.x - ticks[i]!.x);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(128);
  });

  it("keeps the end label of a 1:00 episode at 320 px where '0:45' would have touched it", () => {
    const width = 256;
    const pps = width / 60;
    const ticks = rulerTicks(0, pps, width, rulerStep(pps, 60), 60);
    expect(ticks.map((t) => t.label)).toEqual([
      "0:00",
      "0:15",
      "0:30",
      "",
      "1:00",
    ]);
    expect(ticks.at(-1)?.align).toBe("end");
  });
});
