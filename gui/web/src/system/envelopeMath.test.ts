import { describe, expect, it } from "vitest";
import {
  clampDb,
  DOT_RADIUS_PX,
  dbAfterDrag,
  dbToGain,
  dbToY,
  ENVELOPE_DB_STEP,
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
  sameLevelDb,
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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The vertices of a path made of M and L only. */
function vertices(path: string): [number, number][] {
  return path
    .split(/(?=[ML])/)
    .map((piece) => piece.slice(1).split(" ").map(Number) as [number, number]);
}

/** The y of the polyline at x. */
function yAtX(verts: [number, number][], x: number): number {
  for (let i = 1; i < verts.length; i += 1) {
    const a = verts[i - 1];
    const b = verts[i];
    if (!a || !b || x < a[0] || x > b[0]) continue;
    return b[0] === a[0]
      ? b[1]
      : a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  throw new Error(`no piece at ${x}`);
}

const dbOf = (y: number, height: number) => yToDb(y, height);

describe("linePath", () => {
  it("is the unity line with no points", () => {
    expect(linePath([], 0, 24, 360, 72)).toBe("M0 7.55L360 7.55");
  });

  it("holds to both edges and runs through every point", () => {
    const sorted = sortPoints(points);
    const path = linePath(sorted, 0, 24, 600, 72);
    expect(path.startsWith("M0 13.59L120 13.59L")).toBe(true);
    expect(path.endsWith("L480 7.55L600 7.55")).toBe(true);
    const verts = vertices(path);
    for (const [x, y] of [
      [120, 13.59],
      [300, 10.57],
      [480, 7.55],
    ] as const) {
      expect(verts).toContainEqual([x, y]);
    }
  });

  it("draws the same strings as a straight join for a flat run and for a single level", () => {
    const flat = [
      { id: "a", time: 5, db: -6 },
      { id: "b", time: 12.5, db: -6 },
    ];
    expect(linePath(flat, 0, 24, 600, 72)).toBe(
      "M0 13.59L120 13.59L300 13.59L600 13.59",
    );
    expect(linePath([{ id: "a", time: 5, db: 0 }], 0, 24, 360, 72)).toBe(
      "M0 7.55L120 7.55L360 7.55",
    );
    expect(linePath([{ id: "a", time: 0, db: 0 }], 0, 24, 360, 72)).toBe(
      "M0 7.55L360 7.55",
    );
  });

  it("interpolates in gain: 0 to -20 dB is -5.2 dB at the middle, not -10", () => {
    const sorted = [
      { id: "a", time: 0, db: 0 },
      { id: "b", time: 10, db: -20 },
    ];
    const verts = vertices(linePath(sorted, 0, 24, 240, 72));
    expect(dbOf(yAtX(verts, 120), 72)).toBeCloseTo(-5.19, 1);
  });

  it("goes from unity to the floor through -6.0 dB at the middle", () => {
    const sorted = [
      { id: "a", time: 0, db: 0 },
      { id: "b", time: 10, db: ENVELOPE_FLOOR_DB },
    ];
    for (const height of [72, 240]) {
      const path = linePath(sorted, 0, 24, 240, height);
      const verts = vertices(path);
      expect(dbOf(yAtX(verts, 120), height)).toBeCloseTo(-6.02, 1);
      expect(path.length).toBeLessThan(height === 72 ? 1000 : 3500);
      // The drawn polyline stays within 0.1 px of the true curve, up to the last pixel before the floor,
      // where the curve falls 60 px in under 0.3 px of x and the path's 0.01 px grid shows.
      let worst = 0;
      for (let x = 0; x <= 239; x += 0.05) {
        const gain = Math.max(0, 1 - x / 240);
        worst = Math.max(
          worst,
          Math.abs(yAtX(verts, x) - dbToY(gainToDb(gain), height)),
        );
      }
      expect(worst).toBeLessThan(0.1);
    }
  });

  it("stays within 0.1 px of the curve on short steep segments, 2 to 20 px wide", () => {
    for (const [from, to] of [
      [0, ENVELOPE_FLOOR_DB],
      [ENVELOPE_TOP_DB, ENVELOPE_FLOOR_DB],
      [0, -20],
    ] as const) {
      for (const height of [72, 240]) {
        for (const span of [2, 5, 10, 20]) {
          const sorted = [
            { id: "a", time: 0, db: from },
            { id: "b", time: span / 24, db: to },
          ];
          const verts = vertices(linePath(sorted, 0, 24, 100, height));
          const g0 = dbToGain(from);
          const g1 = dbToGain(to);
          // Distance from the drawn line to the true curve, so the path's 0.01 px grid on a steep part does not count as height.
          const curve: [number, number][] = [];
          for (let x = 0; x <= span; x += 0.01) {
            const gain = g0 + ((g1 - g0) * x) / span;
            curve.push([x, dbToY(gainToDb(gain), height)]);
          }
          // And by level, so a steep part is as dense as a flat one.
          for (let k = 0; k <= 6000; k += 1) {
            const db = from + ((to - from) * k) / 6000;
            const x = clamp01((10 ** (db / 20) - g0) / (g1 - g0)) * span;
            curve.push([x, dbToY(db, height)]);
          }
          let worst = 0;
          for (let x = 0; x <= span; x += 0.05) {
            const y = yAtX(verts, x);
            let near = Number.POSITIVE_INFINITY;
            for (const [cx, cy] of curve) {
              near = Math.min(near, Math.hypot(cx - x, cy - y));
            }
            worst = Math.max(worst, near);
          }
          expect(worst).toBeLessThan(0.1);
        }
      }
    }
  });

  it("goes from the top of the scale to the floor and from the floor up", () => {
    const down = [
      { id: "a", time: 0, db: ENVELOPE_TOP_DB },
      { id: "b", time: 10, db: ENVELOPE_FLOOR_DB },
    ];
    const verts = vertices(linePath(down, 0, 24, 240, 72));
    expect(dbOf(yAtX(verts, 120), 72)).toBeCloseTo(gainToDb(0.75), 1);
    const up = [
      { id: "a", time: 0, db: ENVELOPE_FLOOR_DB },
      { id: "b", time: 10, db: -6 },
    ];
    const rise = vertices(linePath(up, 0, 24, 240, 72));
    expect(dbOf(yAtX(rise, 120), 72)).toBeCloseTo(
      gainToDb(dbToGain(-6) / 2),
      1,
    );
  });

  it("draws a vertical step for two points at the same time", () => {
    const sorted = [
      { id: "a", time: 5, db: 0 },
      { id: "b", time: 5, db: -20 },
    ];
    expect(linePath(sorted, 0, 24, 360, 72)).toBe(
      "M0 7.55L120 7.55L120 27.7L360 27.7",
    );
  });

  it("clips to the window: an off-window first point starts at x 0 on the curve", () => {
    const sorted = sortPoints(points);
    const path = linePath(sorted, 10, 24, 120, 72);
    const verts = vertices(path);
    expect(verts[0]?.[0]).toBe(0);
    expect(verts[verts.length - 1]?.[0]).toBe(120);
    for (const [x] of verts) expect(x).toBeGreaterThanOrEqual(0);
    // a at -120 px (-6 dB), b at 60 px (-3 dB), c at 240 px (0 dB): x 0 is 2/3 of the way to b in gain.
    const g0 = dbToGain(-6);
    const g = g0 + (dbToGain(-3) - g0) * (120 / 180);
    expect(dbOf(verts[0]?.[1] ?? 0, 72)).toBeCloseTo(gainToDb(g), 1);
  });

  it("draws one clipped piece when the window lies between two far points", () => {
    const sorted = [
      { id: "a", time: -1e6, db: 0 },
      { id: "b", time: 1e6, db: -20 },
    ];
    const path = linePath(sorted, 0, 24, 360, 72);
    const verts = vertices(path);
    expect(verts[0]?.[0]).toBe(0);
    expect(verts[verts.length - 1]?.[0]).toBe(360);
    expect(verts.length).toBeLessThan(5);
  });

  it("holds the last level when the window is wholly past the last point or before the first", () => {
    const sorted = sortPoints(points);
    const after = linePath(sorted, 100, 24, 120, 72);
    expect(after).toBe("M0 7.55L120 7.55");
    const before = linePath(sorted, -100, 24, 120, 72);
    expect(before).toBe("M0 13.59L120 13.59");
  });

  it("keeps every coordinate in the window at a deep zoom with 500 points, within a time bound", () => {
    const many = Array.from({ length: 500 }, (_, n) => ({
      id: `p${n}`,
      time: 1e6 + n * 2.5,
      db: n % 2 === 0 ? 0 : -40,
    }));
    const started = performance.now();
    const paths = [
      linePath(many, 1e6, 3600, 1280, 72),
      linePath(many, 1e6 + 600, 3600, 1280, 240),
      linePath(many, 0, 24, 1280, 72),
      linePath(many, 1e6 - 3, 15_000_000 / 3600, 1280, 240),
    ];
    expect(performance.now() - started).toBeLessThan(500);
    for (const path of paths) {
      for (const [x, y] of vertices(path)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1280);
        expect(Number.isFinite(y)).toBe(true);
      }
      expect(path.length).toBeLessThan(120_000);
    }
    expect(paths[2]).toBe("M0 7.55L1280 7.55");
  });

  it("tolerates points that are not finite", () => {
    const sorted = [
      { id: "a", time: Number.NaN, db: 0 },
      { id: "b", time: 5, db: Number.NaN },
      { id: "c", time: 10, db: -6 },
      { id: "d", time: Number.POSITIVE_INFINITY, db: -6 },
    ];
    expect(linePath(sorted, 0, 24, 360, 72)).toBe(
      "M0 13.59L240 13.59L360 13.59",
    );
    expect(linePath(sorted.slice(0, 2), 0, 24, 360, 72)).toBe(
      "M0 7.55L360 7.55",
    );
  });
});

describe("level resolution", () => {
  it("stores 0.01 dB and calls two levels the same inside half of it", () => {
    expect(ENVELOPE_DB_STEP).toBe(0.01);
    expect(sameLevelDb(-1.938, -1.938)).toBe(true);
    expect(sameLevelDb(-1.938, -1.9421)).toBe(true);
    expect(sameLevelDb(-1.938, -1.89)).toBe(false);
    expect(sameLevelDb(-1.938, -1.9)).toBe(false);
    expect(sameLevelDb(-6, gainToDb(dbToGain(-6)))).toBe(true);
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
