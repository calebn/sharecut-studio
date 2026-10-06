import { describe, expect, it } from "vitest";
import {
  AWAY,
  alongAxis,
  type ChipFinger,
  isArmed,
  moveOnChips,
  pressChip,
} from "./chipGesture";

/** Replays moves `[over, x, y, t]` from `start`; returns each step's grab. */
function replay(
  start: ChipFinger,
  axis: "x" | "xy" | "none",
  moves: [number | null, number, number, number][],
) {
  let finger = start;
  return moves.map(([over, x, y, t]) => {
    const step = moveOnChips(finger, over, axis, { x, y }, t);
    finger = step.finger;
    return step.grab;
  });
}

describe("alongAxis", () => {
  it("takes a time-only drag within about 27 degrees of horizontal", () => {
    expect(alongAxis("x", 20, 10)).toBe(true);
    expect(alongAxis("x", -20, 9)).toBe(true);
    expect(alongAxis("x", 20, 11)).toBe(false);
    expect(alongAxis("x", 0, 20)).toBe(false);
  });

  it("takes any direction for a time-and-value target, none for a tap-only one", () => {
    expect(alongAxis("xy", 0, 20)).toBe(true);
    expect(alongAxis("none", 20, 0)).toBe(false);
  });
});

describe("a finger that came down on a chip", () => {
  it("is armed at once and grabs on the first move past the slop along the axis", () => {
    const finger = pressChip(2, { x: 100, y: 50 }, 0);
    expect(isArmed(finger, 0)).toBe(true);
    expect(
      replay(finger, "x", [
        [2, 106, 50, 16],
        [2, 111, 51, 32],
      ]),
    ).toEqual([false, true]);
  });

  it("does not grab when it moves off the axis, and is no longer armed", () => {
    const finger = pressChip(2, { x: 100, y: 50 }, 0);
    const step = moveOnChips(finger, 2, "x", { x: 102, y: 64 }, 16);
    expect(step).toEqual({
      grab: false,
      finger: {
        kind: "over",
        index: 2,
        anchor: { x: 102, y: 64 },
        since: 16,
        pressed: false,
      },
    });
    expect(isArmed(step.finger, 20)).toBe(false);
  });

  it("never grabs a tap-only target", () => {
    expect(
      replay(pressChip(0, { x: 100, y: 50 }, 0), "none", [[0, 140, 50, 16]]),
    ).toEqual([false]);
  });
});

describe("a finger that slid onto a chip", () => {
  it("passes over a chip to the next without grabbing either", () => {
    // Chips 52 px apart; the finger sweeps right at about 1 px per ms.
    expect(
      replay(AWAY, "x", [
        [0, 100, 50, 0],
        [0, 112, 50, 12],
        [0, 124, 50, 24],
        [1, 152, 50, 52],
        [1, 170, 50, 70],
      ]),
    ).toEqual([false, false, false, false, false]);
  });

  it("grabs once it settles for the settle time, then slides along the axis", () => {
    expect(
      replay(AWAY, "x", [
        [1, 152, 50, 0],
        [1, 155, 51, 60],
        [1, 154, 50, 100],
        [1, 140, 52, 116],
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("does not grab a settled chip on a vertical move", () => {
    expect(
      replay(AWAY, "x", [
        [1, 152, 50, 0],
        [1, 152, 50, 150],
        [1, 154, 70, 166],
      ]),
    ).toEqual([false, false, false]);
  });

  it("starts over on each chip it enters", () => {
    expect(
      replay(AWAY, "x", [
        [0, 100, 50, 0],
        [0, 100, 50, 200],
        [1, 152, 50, 216],
        [1, 170, 50, 232],
      ]),
    ).toEqual([false, false, false, false]);
  });

  it("is away, unarmed, between chips", () => {
    const step = moveOnChips(
      pressChip(0, { x: 100, y: 50 }, 0),
      null,
      "x",
      { x: 126, y: 50 },
      16,
    );
    expect(step).toEqual({ finger: AWAY, grab: false });
    expect(isArmed(step.finger, 1000)).toBe(false);
  });
});
