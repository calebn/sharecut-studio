import { describe, expect, it } from "vitest";
import { anchorLost, pinOf } from "./anchorPin";

const box = { left: 100, top: 100, right: 500, bottom: 400 };
const at = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe("pinOf", () => {
  it("attaches an anchor wholly inside the box and keeps its rect", () => {
    const rect = at(200, 200, 300, 240);
    expect(pinOf(rect, box)).toEqual({ pinned: false, rect });
  });

  it.each([
    ["top", at(200, 80, 300, 140), at(200, 100, 300, 140)],
    ["bottom", at(200, 380, 300, 440), at(200, 380, 300, 400)],
    ["start", at(60, 200, 140, 240), at(100, 200, 140, 240)],
    ["end", at(460, 200, 540, 240), at(460, 200, 500, 240)],
  ])(
    "attaches a partial overlap past the %s and clamps the rect to the visible part",
    (_edge, rect, clamped) => {
      expect(pinOf(rect, box)).toEqual({
        pinned: false,
        rect: clamped,
      });
    },
  );

  it.each([
    ["top", at(200, 20, 300, 60), at(200, 100, 300, 100)],
    ["bottom", at(200, 450, 300, 490), at(200, 400, 300, 400)],
    ["start", at(10, 200, 60, 240), at(100, 200, 100, 240)],
    ["end", at(550, 200, 600, 240), at(500, 200, 500, 240)],
  ])(
    "pins an anchor fully past the %s to the nearest edge point",
    (_edge, rect, point) => {
      expect(pinOf(rect, box)).toEqual({ pinned: true, rect: point });
    },
  );

  it("pins to the corner point past a corner", () => {
    expect(pinOf(at(10, 20, 60, 60), box)).toEqual({
      pinned: true,
      rect: at(100, 100, 100, 100),
    });
  });

  it("treats an anchor touching the edge without overlap as out", () => {
    expect(pinOf(at(200, 60, 300, 100), box).pinned).toBe(true);
  });

  it.each([
    ["zero", at(0, 0, 0, 0)],
    ["inverted", at(500, 400, 100, 100)],
  ])("attaches when the box is %s", (_name, bad) => {
    const rect = at(900, 900, 950, 940);
    expect(pinOf(rect, bad)).toEqual({ pinned: false, rect });
  });

  it("attaches a node that has no layout, even at the edge", () => {
    const rect = at(0, 0, 0, 0);
    expect(pinOf(rect, box)).toEqual({ pinned: false, rect });
  });

  it("attaches an anchor larger than the box and clamps it to the box", () => {
    expect(pinOf(at(0, 0, 900, 900), box)).toEqual({
      pinned: false,
      rect: box,
    });
  });
});

describe("anchorLost", () => {
  it.each([
    ["zero size", at(150, 150, 150, 150)],
    ["zero height", at(150, 150, 300, 150)],
    ["zero width", at(150, 150, 150, 300)],
  ])("is lost for a %s anchor in a laid-out box", (_n, rect) => {
    expect(anchorLost(rect, box)).toBe(true);
  });

  it("is not lost for a drawn anchor, or when the box is not laid out", () => {
    expect(anchorLost(at(150, 150, 300, 200), box)).toBe(false);
    expect(anchorLost(at(0, 0, 0, 0), at(0, 0, 0, 0))).toBe(false);
  });
});
