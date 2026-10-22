import { describe, expect, it } from "vitest";
import {
  type AnchorRect,
  inlineSizeCaps,
  placeAnchored,
  placeAnchoredClear,
  unionRect,
  visualViewportBox,
} from "./anchoredPlacement";

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

describe("placeAnchoredClear", () => {
  const clearOptions = { ...options, align: "center" as const, minWidth: 192 };
  const joinPanel = { width: 320, height: 230 };

  function overlap(a: AnchorRect, b: AnchorRect) {
    return (
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom
    );
  }

  function check(
    vp: { left: number; top: number; width: number; height: number },
    chromeTop: number,
    badge: AnchorRect,
    grip: AnchorRect,
  ) {
    const clear = unionRect(badge, grip);
    const placed = placeAnchoredClear(
      badge,
      joinPanel,
      vp,
      chromeTop,
      clear,
      clearOptions,
    );
    const width = Math.min(joinPanel.width, placed.maxWidth);
    const height = Math.min(joinPanel.height, placed.maxHeight);
    const rect = {
      left: placed.left,
      top: placed.top,
      right: placed.left + width,
      bottom: placed.top + height,
    };
    expect(placed.side).toBe("right");
    expect(placed.left).toBeGreaterThanOrEqual(clear.right + GAP);
    expect(rect.right).toBeLessThanOrEqual(vp.left + vp.width - EDGE);
    expect(rect.top).toBeGreaterThanOrEqual(vp.top + EDGE);
    expect(rect.bottom).toBeLessThanOrEqual(vp.top + vp.height - EDGE);
    expect(overlap(rect, grip)).toBe(false);
    expect(overlap(rect, badge)).toBe(false);
  }

  it("sits right of the grip column at 844x390", () => {
    check(
      { left: 0, top: 0, width: 844, height: 390 },
      141.7,
      { left: 180, top: 96, right: 204, bottom: 120 },
      { left: 266.8, top: 141.7, right: 314.8, bottom: 189.7 },
    );
  });

  it("sits right of the grip column at 568x320", () => {
    check(
      { left: 0, top: 0, width: 568, height: 320 },
      165,
      { left: 150, top: 120, right: 174, bottom: 144 },
      { left: 187.4, top: 165, right: 235.4, bottom: 213 },
    );
  });

  it("keeps today's placement when the panel fits whole above the rail", () => {
    const tall = { left: 0, top: 0, width: 390, height: 844 };
    const badge = { left: 120, top: 500, right: 144, bottom: 524 };
    const grip = { left: 94.4, top: 677, right: 142.4, bottom: 725 };
    const clear = {
      left: 94.4,
      top: 500,
      right: 144,
      bottom: 725,
    };
    const placed = placeAnchoredClear(
      badge,
      joinPanel,
      tall,
      grip.top,
      clear,
      clearOptions,
    );
    const old = placeAnchored(
      badge,
      joinPanel,
      { ...tall, height: grip.top },
      clearOptions,
    );
    expect(placed).toEqual(old);
  });
});

describe("inlineSizeCaps", () => {
  const clearOptions = { ...options, align: "center" as const, minWidth: 100 };

  it("sets no inline size when the panel fits above or below", () => {
    const anchor = anchorAt(180, 400);
    const placed = placeAnchoredClear(
      anchor,
      panel,
      viewport,
      null,
      unionRect(anchor, anchorAt(180, 440)),
      clearOptions,
    );
    expect(["above", "below"]).toContain(placed.side);
    expect(inlineSizeCaps(placed, panel)).toBeNull();
  });

  it("caps a beside-the-column placement", () => {
    const short = { left: 0, top: 0, width: 400, height: 150 };
    const anchor = anchorAt(10, 60, 20, 20);
    const tall = { width: 120, height: 400 };
    const placed = placeAnchoredClear(
      anchor,
      tall,
      short,
      null,
      unionRect(anchor, anchorAt(10, 85, 20, 20)),
      clearOptions,
    );
    expect(placed.side).toBe("right");
    expect(inlineSizeCaps(placed, tall)).toEqual({
      maxHeight: placed.maxHeight,
      maxWidth: placed.maxWidth,
    });
  });

  it("caps a vertical placement taller than its room", () => {
    const big = { width: 100, height: 900 };
    const placed = placeAnchored(anchorAt(10, 60), big, viewport, {
      ...options,
      align: "center",
    });
    expect(inlineSizeCaps(placed, big)).not.toBeNull();
  });
});

describe("visualViewportBox", () => {
  function chrome(top: number, rendered: boolean): Element {
    const element = document.createElement("nav");
    element.getBoundingClientRect = () =>
      ({ top: rendered ? top : 0, bottom: rendered ? top + 52 : 0 }) as DOMRect;
    element.getClientRects = () =>
      (rendered
        ? [element.getBoundingClientRect()]
        : []) as unknown as DOMRectList;
    return element;
  }

  it("ends the box at the top of the bottom chrome", () => {
    expect(visualViewportBox(chrome(323, true)).height).toBe(323);
  });

  it("ignores chrome that is not rendered (display: none reads back top 0)", () => {
    const box = visualViewportBox(chrome(323, false));
    expect(box.height).toBe(window.innerHeight);
    expect(box.height).toBeGreaterThan(0);
  });

  it("uses the whole viewport without chrome", () => {
    expect(visualViewportBox(null).height).toBe(window.innerHeight);
  });
});
