import { describe, expect, it } from "vitest";
import { chooserItems, layoutChips, layoutMenu } from "./chooserLayout";
import type { HitCandidate } from "./hitCandidates";

const phone = { left: 0, top: 0, right: 360, bottom: 800 };

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

  it("flips below rather than reach over chrome above the timeline", () => {
    const timeline = { left: 0, top: 160, right: 360, bottom: 700 };
    expect(layoutChips(1, { x: 180, y: 250 }, timeline, 44)).toEqual({
      placement: "below",
      centers: [{ x: 180, y: 314 }],
      caption: { x: 180, y: 344 },
    });
  });

  it("takes the roomier side when neither fits", () => {
    const short = { left: 0, top: 100, right: 360, bottom: 300 };
    expect(layoutChips(1, { x: 180, y: 220 }, short, 44).placement).toBe(
      "above",
    );
    expect(layoutChips(1, { x: 180, y: 180 }, short, 44).placement).toBe(
      "below",
    );
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

describe("layoutMenu", () => {
  const size = { width: 240, height: 218 };
  const viewport = { left: 0, top: 0, right: 844, bottom: 390 };

  it("sits above the finger when there is room", () => {
    const bounds = { left: 0, top: 100, right: 390, bottom: 800 };
    expect(layoutMenu({ x: 247, y: 500 }, bounds, size, null)).toEqual({
      placement: "above",
      left: 127,
      top: 258,
      maxHeight: null,
    });
  });

  it("sits below the finger near the top of the timeline", () => {
    const bounds = { left: 0, top: 100, right: 390, bottom: 800 };
    expect(layoutMenu({ x: 247, y: 260 }, bounds, size, null)).toEqual({
      placement: "below",
      left: 127,
      top: 284,
      maxHeight: null,
    });
  });

  it("falls back to the viewport when the timeline box is shorter than the menu, below the finger rather than over it", () => {
    const bounds = { left: 0, top: 53, right: 844, bottom: 190 };
    expect(
      layoutMenu({ x: 566, y: 116 }, bounds, size, null, viewport),
    ).toEqual({ placement: "below", left: 446, top: 140, maxHeight: null });
  });

  it("goes beside the finger when neither above nor below has room", () => {
    const short = { left: 0, top: 0, right: 844, bottom: 260 };
    expect(layoutMenu({ x: 566, y: 130 }, short, size, null)).toEqual({
      placement: "left",
      left: 302,
      top: 21,
      maxHeight: null,
    });
  });

  it("keeps clear of the fixed playhead above the finger", () => {
    const bounds = { left: 0, top: 0, right: 844, bottom: 800 };
    expect(layoutMenu({ x: 260, y: 500 }, bounds, size, 250).left).toBe(258);
    expect(layoutMenu({ x: 240, y: 500 }, bounds, size, 250).left).toBe(2 + 14);
  });

  it("prefers the side that does not cross the fixed playhead", () => {
    const short = { left: 0, top: 0, right: 844, bottom: 260 };
    expect(layoutMenu({ x: 400, y: 130 }, short, size, 500)).toMatchObject({
      placement: "left",
      left: 136,
    });
  });

  it("caps the menu's height and lets it scroll when even the viewport is too short", () => {
    const tiny = { left: 0, top: 0, right: 844, bottom: 200 };
    expect(
      layoutMenu({ x: 400, y: 100 }, tiny, { width: 240, height: 300 }, null),
    ).toEqual({
      placement: "right",
      left: 424,
      top: 16,
      maxHeight: 168,
    });
  });

  it("keeps the finger at least a gap away from the menu wherever it presses", () => {
    const presses: [number, number][] = [
      [566, 116],
      [30, 30],
      [820, 370],
      [420, 195],
    ];
    const gaps = presses.map(([x, y]) => {
      const out = layoutMenu({ x, y }, viewport, size, null);
      const height = out.maxHeight ?? size.height;
      return Math.max(
        out.left - x,
        x - (out.left + size.width),
        out.top - y,
        y - (out.top + height),
      );
    });
    expect(gaps).toEqual([24, 24, 24, 24]);
  });
});
