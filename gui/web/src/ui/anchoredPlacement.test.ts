import { describe, expect, it } from "vitest";
import { placeAnchored } from "./anchoredPlacement";

const viewport = { left: 0, top: 0, width: 400, height: 800 };
const EDGE = 8;
const GAP = 4;
const options = { margin: EDGE, gap: GAP };
const panel = { width: 240, height: 120 };

function anchorAt(left: number, top: number, width = 40, height = 32) {
  return { left, top, right: left + width, bottom: top + height };
}

describe("placeAnchored", () => {
  it("aligns the panel's end edge to the anchor's end and drops below it", () => {
    const placed = placeAnchored(anchorAt(300, 100), panel, viewport, {
      ...options,
      align: "end",
    });
    expect(placed).toMatchObject({ left: 100, top: 136, side: "below" });
  });

  it("clamps inside the left edge when the anchor hugs it", () => {
    const placed = placeAnchored(anchorAt(0, 100), panel, viewport, {
      ...options,
      align: "end",
    });
    expect(placed.left).toBe(8);
  });

  it("clamps inside the right edge when the anchor hugs it", () => {
    const placed = placeAnchored(anchorAt(360, 100), panel, viewport, {
      ...options,
      align: "start",
    });
    expect(placed.left).toBe(400 - 8 - 240);
  });

  it("centres on the anchor and clamps at the edge", () => {
    const centre = placeAnchored(anchorAt(180, 100), panel, viewport, {
      ...options,
      align: "center",
    });
    expect(centre.left).toBe(80);
    const atLeft = placeAnchored(anchorAt(0, 100), panel, viewport, {
      ...options,
      align: "center",
    });
    expect(atLeft.left).toBe(8);
  });

  it("flips above the anchor at the bottom edge", () => {
    const placed = placeAnchored(anchorAt(100, 740), panel, viewport, {
      ...options,
      align: "end",
    });
    expect(placed).toMatchObject({ side: "above", top: 740 - 4 - 120 });
  });

  it("keeps the panel below and caps its height when neither side fits it", () => {
    const placed = placeAnchored(
      anchorAt(100, 150),
      { width: 240, height: 900 },
      viewport,
      { ...options, align: "end" },
    );
    expect(placed.side).toBe("below");
    expect(placed.top + placed.maxHeight).toBe(800 - 8);
  });

  it("caps the height on the roomier side and flips when that side is above", () => {
    const placed = placeAnchored(
      anchorAt(100, 600),
      { width: 240, height: 900 },
      viewport,
      { ...options, align: "end" },
    );
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(8);
    expect(placed.maxHeight).toBe(600 - 4 - 8);
  });

  it("caps the width and pins to the left margin when wider than the space on both sides", () => {
    const placed = placeAnchored(
      anchorAt(180, 100),
      { width: 600, height: 120 },
      viewport,
      { ...options, align: "end" },
    );
    expect(placed.left).toBe(8);
    expect(placed.maxWidth).toBe(400 - 16);
  });

  it("works inside an offset visual viewport", () => {
    const zoomed = { left: 50, top: 200, width: 200, height: 300 };
    const placed = placeAnchored(anchorAt(50, 250), panel, zoomed, {
      ...options,
      align: "end",
    });
    expect(placed.left).toBe(58);
    expect(placed.maxWidth).toBe(184);
  });
});
