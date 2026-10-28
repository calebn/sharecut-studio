import { describe, expect, it } from "vitest";
import {
  edgeScrollDelta,
  isDoubleTap,
  pressKind,
  pressSlop,
} from "./scriptGesture";

describe("edgeScrollDelta", () => {
  it("is zero in the middle and scrolls toward the nearer edge", () => {
    expect(edgeScrollDelta(300, 0, 600)).toBe(0);
    expect(edgeScrollDelta(56, 0, 600)).toBe(0);
    expect(edgeScrollDelta(40, 0, 600)).toBe(-6);
    expect(edgeScrollDelta(570, 0, 600)).toBe(8.5);
  });

  it("speeds up with depth, capped at 14 px a frame, and scrolls from outside the body", () => {
    expect(edgeScrollDelta(0, 0, 600)).toBe(-14);
    expect(edgeScrollDelta(-400, 0, 600)).toBe(-14);
    expect(edgeScrollDelta(1000, 0, 600)).toBe(14);
  });

  it("keeps a middle in a short body", () => {
    expect(edgeScrollDelta(100, 0, 200)).toBe(0);
    expect(edgeScrollDelta(190, 0, 200)).toBe(12);
  });
});

describe("press kinds", () => {
  it("reads touch and pen, and takes everything else for a mouse", () => {
    expect(["touch", "pen", "mouse", ""].map(pressKind)).toEqual([
      "touch",
      "pen",
      "mouse",
      "mouse",
    ]);
  });

  it("uses the touch slop for a finger and the move threshold for a pointer", () => {
    expect([pressSlop("touch"), pressSlop("mouse"), pressSlop("pen")]).toEqual([
      10, 5, 5,
    ]);
  });
});

describe("isDoubleTap", () => {
  it("needs the same word within 350 ms", () => {
    expect(isDoubleTap({ index: 3, at: 1000 }, 3, 1349)).toBe(true);
    expect(isDoubleTap({ index: 3, at: 1000 }, 3, 1350)).toBe(false);
    expect(isDoubleTap({ index: 3, at: 1000 }, 4, 1100)).toBe(false);
    expect(isDoubleTap(null, 3, 1100)).toBe(false);
  });
});
