import { describe, expect, it } from "vitest";
import {
  clampToSession,
  clockLabel,
  formatDurationLabel,
  formatIngestDuration,
  formatRulerTime,
  formatTime,
  formatTimecodeCompact,
  formatTimecodePair,
  formatTimeMs,
  formatTimeShort,
  niceTimeStep,
  parseTimecode,
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

describe("hour layout at the rounding boundary", () => {
  it("lays a duration that rounds to one hour out as hh:mm:ss for both times", () => {
    expect(formatTimecodePair(0, 3599.9996)).toBe(
      "00:00:00.000 / 01:00:00.000",
    );
    expect(transportTimecode(0, 3599.9996)).toEqual({
      current: "00:00:00.000",
      total: "01:00:00.000",
      title: "00:00:00.000 / 01:00:00.000",
    });
  });

  it("keeps mm:ss while the duration still rounds below an hour", () => {
    expect(formatTimecodePair(0, 3599.9994)).toBe("00:00.000 / 59:59.999");
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

describe("clockLabel", () => {
  it("matches server cut toasts (m:ss.s)", () => {
    expect(clockLabel(1.2)).toBe("0:01.2");
    expect(clockLabel(72.1)).toBe("1:12.1");
    expect(clockLabel(null)).toBe("?");
  });

  it("uses h:mm:ss.s past an hour", () => {
    expect(clockLabel(3661.2)).toBe("1:01:01.2");
  });
});

describe("formatTime", () => {
  it("pads hours when forced", () => {
    expect(formatTime(65, { forceHours: true })).toBe("00:01:05.000");
  });

  it("rounds to the displayed millisecond instead of flooring", () => {
    expect(formatTime(16.04)).toBe("00:16.040");
    expect(formatTime(0.29)).toBe("00:00.290");
    expect(formatTime(1.0004)).toBe("00:01.000");
    expect(formatTime(1.0006)).toBe("00:01.001");
  });

  it("carries a rounded-up millisecond into seconds, minutes and hours", () => {
    expect(formatTime(59.9995)).toBe("01:00.000");
    expect(formatTime(59.9994)).toBe("00:59.999");
    expect(formatTime(3599.9996)).toBe("01:00:00.000");
    expect(formatTime(3599.9996, { forceHours: true })).toBe("01:00:00.000");
  });

  it("reads zero and clamps negative input to zero", () => {
    expect(formatTime(0)).toBe("00:00.000");
    expect(formatTime(-3.2)).toBe("00:00.000");
    expect(formatTime(-0.0004)).toBe("00:00.000");
  });
});

describe("formatDurationLabel", () => {
  it("uses rounded human duration units instead of timecode punctuation", () => {
    expect(formatDurationLabel(1046)).toBe("17m 26s");
    expect(formatDurationLabel(59.6)).toBe("1m 0s");
    expect(formatDurationLabel(5.4)).toBe("5s");
    expect(formatDurationLabel(3723)).toBe("1h 2m 3s");
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

  it("steps by hours for an episode of many hours, and stops at a day", () => {
    expect(niceTimeStep(0.01, 64)).toBe(7200);
    expect(niceTimeStep(0.005, 64)).toBe(14400);
    expect(niceTimeStep(0.003, 64)).toBe(21600);
    expect(niceTimeStep(0.0015, 64)).toBe(43200);
    expect(niceTimeStep(0.001)).toBe(86400);
    expect(niceTimeStep(1e-9)).toBe(86400);
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
    [59.68, 1, "1:00"],
    [59.5, 1, "1:00"],
    [59.4999, 1, "0:59"],
    [12.7, 1, "0:13"],
    [3599.5, 1, "1:00:00"],
    [59.68, 0.5, "0:59.7"],
    [59.96, 0.1, "1:00.0"],
    [59.9999995, 1, "1:00"],
  ])(
    "rounds %s s at a %s s step to %s, the same as a tick label",
    (sec, step, label) => {
      expect(formatRulerTime(sec, step)).toBe(label);
    },
  );
});

describe("formatTimeShort", () => {
  it("formats seconds as m:ss", () => {
    expect(formatTimeShort(65)).toBe("1:05");
    expect(formatTimeShort(65.4)).toBe("1:05");
  });

  it.each([
    [59.9995, "1:00"],
    [59.5, "1:00"],
    [59.4999, "0:59"],
    [0.5, "0:01"],
    [0.4999, "0:00"],
    [65.9, "1:06"],
    [3599.5, "1:00:00"],
    [3599.4999, "59:59"],
  ])("rounds %s s to the whole second it shows, as %s", (sec, label) => {
    expect(formatTimeShort(sec)).toBe(label);
  });

  it.each([0, 0.4999, 0.5, 12.7, 59.5, 59.9995, 65.9, 3599.5, 7199.6])(
    "reads %s s as the ruler's whole-second label does",
    (sec) => {
      expect(formatTimeShort(sec)).toBe(formatRulerTime(sec, 1));
    },
  );

  it("shows the minute the transport shows for a time just short of it", () => {
    expect(formatTime(59.9995)).toBe("01:00.000");
    expect(formatTimeShort(59.9995)).toBe("1:00");
  });

  it("switches to h:mm:ss from one hour", () => {
    expect(formatTimeShort(3599)).toBe("59:59");
    expect(formatTimeShort(3600)).toBe("1:00:00");
    expect(formatTimeShort(4500)).toBe("1:15:00");
    expect(formatTimeShort(37230)).toBe("10:20:30");
  });

  it("clamps negative values to 0:00", () => {
    expect(formatTimeShort(-3)).toBe("0:00");
  });
});

describe("clampToSession", () => {
  it("clamps to the session, skipping the upper bound when unknown", () => {
    expect(clampToSession(5, 60)).toBe(5);
    expect(clampToSession(90, 60)).toBe(60);
    expect(clampToSession(-1, 60)).toBe(0);
    expect(clampToSession(90, Number.NaN)).toBe(90);
    expect(clampToSession(-1, Number.NaN)).toBe(0);
    expect(clampToSession(5, 0)).toBe(0);
  });
});

describe("formatTimeMs", () => {
  it("prints m:ss.mmm, h:mm:ss.mmm from an hour, and rolls over cleanly", () => {
    expect(formatTimeMs(1.999999)).toBe("0:02.000");
    expect(formatTimeMs(2.38)).toBe("0:02.380");
    expect(formatTimeMs(3723.5)).toBe("1:02:03.500");
  });
});

describe("parseTimecode", () => {
  it("reads m:ss.mmm, h:mm:ss.mmm and plain seconds", () => {
    expect(parseTimecode("0:02.380")).toBeCloseTo(2.38, 9);
    expect(parseTimecode("1:02:03.5")).toBeCloseTo(3723.5, 9);
    expect(parseTimecode("12.5")).toBe(12.5);
  });
  it("rejects malformed times", () => {
    for (const bad of [
      "",
      "a",
      "1:60",
      "1.5:00",
      "1:2:3:4",
      "1:75",
      "1:60:00",
    ]) {
      expect(parseTimecode(bad), bad).toBeNull();
    }
  });
  it("round-trips formatTimeMs", () => {
    for (const sec of [0, 2.38, 61.005, 3723.5]) {
      expect(parseTimecode(formatTimeMs(sec))).toBeCloseTo(sec, 3);
    }
  });
});

describe("formatIngestDuration", () => {
  it("formats status durations", () => {
    expect(formatIngestDuration(0.5)).toBe("0.5s");
    expect(formatIngestDuration(60)).toBe("1:00");
    expect(formatIngestDuration(59.96)).toBe("1:00");
    expect(formatIngestDuration(119.7)).toBe("2:00");
    expect(formatIngestDuration(125.4)).toBe("2:05");
  });
});
