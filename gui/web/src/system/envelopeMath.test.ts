import { describe, expect, it } from "vitest";
import {
  clampDb,
  DOT_RADIUS_PX,
  dbAfterDrag,
  dbToGain,
  dbToY,
  ENVELOPE_FLOOR_DB,
  ENVELOPE_TOP_DB,
  formatDb,
  gainToDb,
  hitRadius,
  levelStep,
  linePath,
  nearestGapPx,
  pointBounds,
  pointVisible,
  pointY,
  readoutText,
  roundDb,
  sortPoints,
  timeStep,
  valueText,
  yToDb,
} from "./envelopeMath";

const points = [
  { id: "c", time: 20, db: 0 },
  { id: "a", time: 5, db: -6 },
  { id: "b", time: 12.5, db: -3 },
];

describe("the scale", () => {
  it("runs from -60 dB to the stored gain's ceiling, +3.52 dB", () => {
    expect(ENVELOPE_FLOOR_DB).toBe(-60);
    expect(ENVELOPE_TOP_DB).toBeCloseTo(3.5218, 4);
  });

  it("puts 0 dB 7.55 px from the top of a 72 px lane, the top at the 4 px pad and the floor 4 px from the bottom", () => {
    expect(dbToY(ENVELOPE_TOP_DB, 72)).toBeCloseTo(4, 6);
    expect(dbToY(0, 72)).toBeCloseTo(7.5483, 3);
    expect(dbToY(-3, 72)).toBeCloseTo(10.5709, 3);
    expect(dbToY(-60, 72)).toBeCloseTo(68, 6);
  });

  it("stretches over a 240 px lane", () => {
    expect(dbToY(0, 240)).toBeCloseTo(4 + 3.5218 * (232 / 63.5218), 3);
    expect(dbToY(-60, 240)).toBeCloseTo(236, 6);
  });

  it("holds a level off the scale to its end", () => {
    expect(dbToY(-90, 72)).toBeCloseTo(68, 6);
    expect(dbToY(12, 72)).toBeCloseTo(4, 6);
    expect(clampDb(-90)).toBe(-60);
    expect(clampDb(6)).toBeCloseTo(ENVELOPE_TOP_DB, 6);
  });

  it("reads a y back as the level, within the scale", () => {
    for (const db of [-60, -30, -3, 0, 3.5]) {
      expect(yToDb(dbToY(db, 104), 104)).toBeCloseTo(db, 6);
    }
    expect(yToDb(-20, 72)).toBeCloseTo(ENVELOPE_TOP_DB, 6);
    expect(yToDb(200, 72)).toBe(-60);
  });

  it("moves a level by a vertical drag, one dB for about a px at 72", () => {
    expect(dbAfterDrag(-3, -5, 72)).toBeCloseTo(-3 + 5 / 1.00753, 3);
    expect(dbAfterDrag(-3, 400, 72)).toBe(-60);
    expect(dbAfterDrag(-3, -400, 72)).toBeCloseTo(ENVELOPE_TOP_DB, 6);
  });

  it("draws a dot at least 7 px from the lane's edges, though the line is not held", () => {
    expect(pointY(0, 72)).toBeCloseTo(7.5483, 3);
    expect(pointY(ENVELOPE_TOP_DB, 72)).toBe(7);
    expect(pointY(-60, 72)).toBe(65);
    expect(pointY(-60, 240)).toBe(233);
  });
});

describe("dB and gain", () => {
  it("converts at -60, -3, 0 and +3.5 dB", () => {
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(-90)).toBe(0);
    expect(dbToGain(-3)).toBeCloseTo(0.70795, 5);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(3.5)).toBeCloseTo(1.4962, 4);
    expect(dbToGain(ENVELOPE_TOP_DB)).toBeCloseTo(1.5, 10);
  });

  it("never gives more than the stored ceiling", () => {
    expect(dbToGain(12)).toBe(1.5);
  });

  it("reads gain 0 as the floor and 1.5 as the top", () => {
    expect(gainToDb(0)).toBe(-60);
    expect(gainToDb(-1)).toBe(-60);
    expect(gainToDb(Number.NaN)).toBe(-60);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(1.5)).toBeCloseTo(ENVELOPE_TOP_DB, 10);
    expect(gainToDb(0.0001)).toBe(-60);
    expect(gainToDb(9)).toBeCloseTo(ENVELOPE_TOP_DB, 10);
  });

  it("round-trips 1.5, 1, 0.5 and 0", () => {
    for (const gain of [1.5, 1, 0.5, 0]) {
      expect(dbToGain(gainToDb(gain))).toBeCloseTo(gain, 10);
    }
  });
});

describe("pointBounds", () => {
  const sorted = sortPoints(points);

  it("sorts by time, and by id where times are equal", () => {
    expect(sorted.map((point) => point.id)).toEqual(["a", "b", "c"]);
    expect(
      sortPoints([
        { id: "z", time: 4, db: 0 },
        { id: "m", time: 4, db: 0 },
      ]).map((point) => point.id),
    ).toEqual(["m", "z"]);
  });

  it("keeps a point a millisecond clear of both neighbours", () => {
    expect(pointBounds(sorted, 1, 60)).toEqual([5.001, 19.999]);
  });

  it("holds the first point to 0 and the last to the episode", () => {
    expect(pointBounds(sorted, 0, 60)).toEqual([0, 12.499]);
    expect(pointBounds(sorted, 2, 60)).toEqual([12.501, 60]);
  });

  it("leaves the end open for an episode of unknown length", () => {
    expect(pointBounds(sorted, 2, 0)).toEqual([12.501, Infinity]);
  });

  it("holds a lone point to the episode", () => {
    expect(pointBounds([{ id: "a", time: 3, db: 0 }], 0, 30)).toEqual([0, 30]);
  });

  it("never gives a maximum below the minimum, for neighbours a millisecond apart", () => {
    const tight = sortPoints([
      { id: "a", time: 1, db: 0 },
      { id: "b", time: 1.001, db: 0 },
      { id: "c", time: 1.002, db: 0 },
    ]);
    const [min, max] = pointBounds(tight, 1, 30);
    expect(max).toBeGreaterThanOrEqual(min);
  });

  it("holds a crowded point where it is, so no nudge can jump a neighbour", () => {
    const same = sortPoints([
      { id: "a", time: 1, db: 0 },
      { id: "b", time: 1, db: 0 },
      { id: "c", time: 1, db: 0 },
    ]);
    expect(pointBounds(same, 1, 30)).toEqual([1, 1]);
    const tight = sortPoints([
      { id: "a", time: 1, db: 0 },
      { id: "b", time: 1.001, db: 0 },
      { id: "c", time: 1.002, db: 0 },
    ]);
    const [min, max] = pointBounds(tight, 1, 30);
    expect(min).toBeCloseTo(1.001, 9);
    expect(max).toBeCloseTo(1.001, 9);
  });
});

describe("hit areas", () => {
  it("is 8 px on a fine pointer and 22 px, a 44 px circle, on a coarse one", () => {
    expect(hitRadius(false, 1000)).toBe(8);
    expect(hitRadius(true, 1000)).toBe(22);
  });

  it("is capped at half the gap to the neighbour, but never below the dot", () => {
    expect(hitRadius(true, 30)).toBe(15);
    expect(hitRadius(false, 12)).toBe(6);
    expect(hitRadius(true, 4)).toBe(DOT_RADIUS_PX);
  });

  it("finds the nearest neighbour in px", () => {
    const sorted = sortPoints(points);
    expect(nearestGapPx(sorted, 0, 24)).toBe(180);
    expect(nearestGapPx(sorted, 1, 24)).toBe(180);
    expect(nearestGapPx(sorted, 2, 24)).toBe(180);
    expect(nearestGapPx(sorted.slice(0, 1), 0, 24)).toBe(Infinity);
  });
});

describe("pointVisible", () => {
  it("uses the clip's window and its 6 px of slack", () => {
    expect(pointVisible(5, 0, 24, 360)).toBe(true);
    expect(pointVisible(15.2, 0, 24, 360)).toBe(true);
    expect(pointVisible(15.3, 0, 24, 360)).toBe(false);
    expect(pointVisible(-0.2, 0, 24, 360)).toBe(true);
    expect(pointVisible(-0.3, 0, 24, 360)).toBe(false);
  });
});

describe("linePath", () => {
  it("is the unity line with no points", () => {
    expect(linePath([], 0, 24, 360, 72)).toBe("M0 7.55L360 7.55");
  });

  it("runs flat to both edges of the window through the points", () => {
    const sorted = sortPoints(points);
    expect(linePath(sorted, 0, 24, 600, 72)).toBe(
      "M0 13.59L120 13.59L300 10.57L480 7.55L600 7.55",
    );
  });

  it("starts at an off-window first point and stops at the edge", () => {
    const sorted = sortPoints(points);
    expect(linePath(sorted, 10, 24, 120, 72)).toBe(
      "M-120 13.59L60 10.57L240 7.55",
    );
  });
});

describe("text", () => {
  it("uses the readout chip's minus sign and no sign for zero", () => {
    expect(formatDb(-3)).toBe("−3.0 dB");
    expect(formatDb(0)).toBe("0.0 dB");
    expect(formatDb(-0.04)).toBe("0.0 dB");
    expect(formatDb(3.52)).toBe("+3.5 dB");
    expect(formatDb(-60)).toBe("−60.0 dB");
  });

  it("writes the chip as level then time", () => {
    expect(readoutText(-3, 724.3)).toBe("−3.0 dB · 12:04.3");
  });

  it("writes a slider's value text with the time", () => {
    expect(valueText(-3, 724.3)).toBe("−3.0 dB at 12:04.30");
  });

  it("rounds a level to 0.1", () => {
    expect(roundDb(-3.04)).toBe(-3);
    expect(roundDb(-3.06)).toBe(-3.1);
  });
});

describe("nudge steps", () => {
  it("moves in time by 10 ms, Shift 100 ms", () => {
    expect(timeStep(false)).toBe(0.01);
    expect(timeStep(true)).toBe(0.1);
  });

  it("moves in level by 0.5 dB, Shift 5, Alt 0.05", () => {
    expect(levelStep(false, false)).toBe(0.5);
    expect(levelStep(true, false)).toBe(5);
    expect(levelStep(false, true)).toBe(0.05);
  });
});
