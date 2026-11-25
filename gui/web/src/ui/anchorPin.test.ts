import { describe, expect, it } from "vitest";
import { pinOf } from "./anchorPin";

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
    expect(pinOf(rect, box)).toEqual({ pinned: false, edge: null, rect });
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
        edge: null,
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
    (edge, rect, point) => {
      expect(pinOf(rect, box)).toEqual({ pinned: true, edge, rect: point });
    },
  );

  it("reports the vertical edge at a corner and pins to the corner point", () => {
    expect(pinOf(at(10, 20, 60, 60), box)).toEqual({
      pinned: true,
      edge: "top",
      rect: at(100, 100, 100, 100),
    });
    expect(pinOf(at(550, 450, 600, 490), box).edge).toBe("bottom");
  });

  it("treats an anchor touching the edge without overlap as out", () => {
    expect(pinOf(at(200, 60, 300, 100), box).pinned).toBe(true);
  });

  it("has nothing to pin without a node", () => {
    expect(pinOf(null, box)).toEqual({ pinned: false, edge: null, rect: null });
  });

  it.each([
    ["zero", at(0, 0, 0, 0)],
    ["inverted", at(500, 400, 100, 100)],
  ])("attaches when the box is %s", (_name, bad) => {
    const rect = at(900, 900, 950, 940);
    expect(pinOf(rect, bad)).toEqual({ pinned: false, edge: null, rect });
  });

  it("attaches a node that has no layout, even at the edge", () => {
    const rect = at(0, 0, 0, 0);
    expect(pinOf(rect, box)).toEqual({ pinned: false, edge: null, rect });
  });

  it("attaches an anchor larger than the box and clamps it to the box", () => {
    expect(pinOf(at(0, 0, 900, 900), box)).toEqual({
      pinned: false,
      edge: null,
      rect: box,
    });
  });
});
