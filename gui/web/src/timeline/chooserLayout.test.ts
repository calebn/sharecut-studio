import { describe, expect, it } from "vitest";
import { chooserItems, layoutChips } from "./chooserLayout";
import type { HitCandidate } from "./hitCandidates";

const phone = { width: 360, height: 800 };

function candidate(x: number, priority = 4): HitCandidate {
  return {
    kind: "trim-in",
    id: `c${x}`,
    x,
    y: 0,
    distance: 0,
    priority,
    selected: false,
  };
}

describe("layoutChips", () => {
  it("centres a shallow arc 64 px above the finger", () => {
    expect(layoutChips(3, { x: 180, y: 400 }, phone, 44)).toEqual({
      placement: "above",
      centers: [
        { x: 128, y: 348 },
        { x: 180, y: 336 },
        { x: 232, y: 348 },
      ],
      caption: { x: 180, y: 306 },
    });
  });

  it("swings away from the left edge, keeping a 16 px gutter", () => {
    const { centers } = layoutChips(3, { x: 30, y: 400 }, phone, 44);
    expect(centers).toEqual([
      { x: 38, y: 336 + 12 * (8 / 112) ** 2 },
      { x: 90, y: 336 + 12 * (60 / 112) ** 2 },
      { x: 142, y: 348 },
    ]);
  });

  it("mirrors that at the right edge", () => {
    const { centers } = layoutChips(3, { x: 330, y: 400 }, phone, 44);
    expect(centers.map((c) => c.x)).toEqual([218, 270, 322]);
  });

  it("flips below the finger near the top of the screen", () => {
    expect(layoutChips(1, { x: 180, y: 100 }, phone, 44)).toEqual({
      placement: "below",
      centers: [{ x: 180, y: 164 }],
      caption: { x: 180, y: 194 },
    });
  });

  it("keeps the caption inside the gutter at a side edge", () => {
    expect(layoutChips(3, { x: 30, y: 400 }, phone, 44).caption).toEqual({
      x: 136,
      y: 336 + 12 * (8 / 112) ** 2 - 22 - 8,
    });
  });

  it("spaces chips by their measured size", () => {
    const { centers } = layoutChips(2, { x: 180, y: 400 }, phone, 88);
    expect(centers.map((c) => c.x)).toEqual([132, 228]);
  });
});

describe("chooserItems", () => {
  it("shows every candidate up to five, left to right by real x", () => {
    expect(
      chooserItems([candidate(210), candidate(190), candidate(200)], 0),
    ).toEqual([
      { kind: "hit", index: 1 },
      { kind: "hit", index: 2 },
      { kind: "hit", index: 0 },
    ]);
  });

  it("breaks an x tie by priority", () => {
    expect(chooserItems([candidate(200, 4), candidate(200, 9)], 0)).toEqual([
      { kind: "hit", index: 1 },
      { kind: "hit", index: 0 },
    ]);
  });

  it("pages more than five as four ranked targets and More, wrapping", () => {
    const seven = [5, 4, 3, 2, 1, 0, 6].map((x) => candidate(x));
    expect(chooserItems(seven, 0)).toEqual([
      { kind: "hit", index: 3 },
      { kind: "hit", index: 2 },
      { kind: "hit", index: 1 },
      { kind: "hit", index: 0 },
      { kind: "more" },
    ]);
    expect(chooserItems(seven, 1)).toEqual([
      { kind: "hit", index: 5 },
      { kind: "hit", index: 4 },
      { kind: "hit", index: 6 },
      { kind: "more" },
    ]);
    expect(chooserItems(seven, 2)).toEqual(chooserItems(seven, 0));
  });
});
