import { describe, expect, it } from "vitest";
import { projectedHeight, releaseVelocity, settleDetent } from "./drawerMotion";

/** A 780px slot on a 390x844 phone: strip 120, half 390, full 780. */
const HEIGHTS = [
  ["peek", 120],
  ["half", 390],
  ["full", 780],
] as const;

describe("releaseVelocity", () => {
  it("reads the speed of the last 100 ms of moves, px/ms, down positive", () => {
    expect(
      releaseVelocity(
        [
          { y: 600, t: 1000 },
          { y: 560, t: 1040 },
          { y: 500, t: 1080 },
          { y: 420, t: 1120 },
        ],
        1130,
      ),
    ).toBe(-1.75);
  });

  it("keeps a flick's speed when the lift lands where the last move did", () => {
    expect(
      releaseVelocity(
        [
          { y: 600, t: 1000 },
          { y: 520, t: 1040 },
          { y: 520, t: 1060 },
        ],
        1060,
      ),
    ).toBe(-2);
  });

  it("is zero for a finger that rested 40 ms or more before it lifted", () => {
    expect(
      releaseVelocity(
        [
          { y: 600, t: 1000 },
          { y: 520, t: 1040 },
          { y: 520, t: 1100 },
        ],
        1100,
      ),
    ).toBe(0);
    expect(releaseVelocity([{ y: 450, t: 1600 }], 1600)).toBe(0);
    expect(releaseVelocity([], 1600)).toBe(0);
  });
});

describe("projectedHeight", () => {
  it("coasts velocity × d/(1 − d) further, d = 0.998 per ms (499 ms)", () => {
    expect(projectedHeight(400, -1)).toBeCloseTo(899, 6);
    expect(projectedHeight(400, 0.5)).toBeCloseTo(150.5, 6);
    expect(projectedHeight(400, 0)).toBe(400);
  });
});

describe("settleDetent", () => {
  it("lands a slow drag at the detent nearest where it was left", () => {
    expect(settleDetent(HEIGHTS, 230, 0)).toBe("peek");
    expect(settleDetent(HEIGHTS, 280, 0)).toBe("half");
    expect(settleDetent(HEIGHTS, 560, 0.05)).toBe("half");
    expect(settleDetent(HEIGHTS, 620, -0.05)).toBe("full");
  });

  it("sends a quick flick all the way, however short the drag", () => {
    // From the strip, 40px up at 1.5 px/ms projects past full.
    expect(settleDetent(HEIGHTS, 160, -1.5)).toBe("full");
    // From full, 40px down at 1.5 px/ms projects below the strip.
    expect(settleDetent(HEIGHTS, 740, 1.5)).toBe("peek");
  });

  it("moves one detent for a gentle push", () => {
    expect(settleDetent(HEIGHTS, 160, -0.4)).toBe("half");
    expect(settleDetent(HEIGHTS, 740, 0.4)).toBe("half");
  });
});
