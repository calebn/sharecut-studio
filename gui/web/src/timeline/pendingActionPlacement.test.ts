import { describe, expect, it } from "vitest";
import { placePendingActionbar } from "./pendingActionPlacement";

function availablePlacement(
  position: ReturnType<typeof placePendingActionbar>,
) {
  if (!position) throw new Error("Expected an available actionbar placement");
  return position;
}

describe("placePendingActionbar", () => {
  const panel = { width: 240, height: 120, reach: 120 };
  const viewport = { width: 390, height: 844 };

  it("places the actions below the lane without covering its handles", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 100, bottom: 200, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(208);
    expect(position.maxHeight).toBe(628);
  });

  it("flips above a lane near the viewport bottom", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 320, top: 700, bottom: 810, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(572);
    expect(position.left).toBe(142);
    expect(position.maxHeight).toBe(684);
  });

  it("caps a tall panel to the roomier side and keeps it outside the lane", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 400, bottom: 500, width: 14 },
        { width: 240, height: 400, reach: 82 },
        viewport,
        8,
      ),
    );
    expect(position).toEqual({ left: 8, top: 8, maxHeight: 384 });
    expect(position.top + position.maxHeight).toBeLessThan(400);
  });

  it("uses the roomier side and caps to its full available height", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 400, bottom: 500, width: 14 },
        { width: 240, height: 700, reach: 82 },
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(8);
    expect(position.maxHeight).toBe(384);
    expect(position.top + position.maxHeight).toBeLessThan(400);
  });

  it("keeps placement inside the viewport when the lane is below it", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 1000, bottom: 1100, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(708);
    expect(position.top + panel.height).toBeLessThanOrEqual(
      viewport.height - 8,
    );
  });

  it("keeps placement inside the viewport when the lane is above it", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: -100, bottom: -40, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(16);
    expect(position.top).toBeGreaterThanOrEqual(8);
  });

  it("keeps a card that flips above the lane under the sticky timeline chrome", () => {
    const withChrome = { ...viewport, top: 120 };
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 700, bottom: 800, width: 14 },
        { width: 240, height: 600, reach: 82 },
        withChrome,
        8,
      ),
    );
    expect(position.top).toBeGreaterThanOrEqual(128);
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(700);
  });

  it("falls to the roomier side below when the chrome leaves little room above and neither side fits the card", () => {
    expect(
      placePendingActionbar(
        { left: 120, top: 200, bottom: 260, width: 14 },
        { width: 240, height: 600, reach: 82 },
        { width: 1280, height: 700, top: 100 },
        8,
      ),
    ).toEqual({ left: 8, top: 268, maxHeight: 424 });
  });

  it("falls to the roomier side above when the bottom panel leaves little room below and neither side fits the card", () => {
    expect(
      placePendingActionbar(
        { left: 120, top: 500, bottom: 560, width: 14 },
        { width: 240, height: 600, reach: 82 },
        { width: 1280, height: 700, top: 100 },
        8,
      ),
    ).toEqual({ left: 8, top: 108, maxHeight: 384 });
  });

  it("prefers the side below when both sides are equally roomy and neither fits the card", () => {
    expect(
      placePendingActionbar(
        { left: 120, top: 300, bottom: 360, width: 14 },
        { width: 240, height: 600, reach: 82 },
        { width: 1280, height: 560, top: 100 },
        8,
      ),
    ).toEqual({ left: 8, top: 368, maxHeight: 184 });
  });

  it("leaves the actions inline when the card cannot fit between the ruler and the bottom panel", () => {
    expect(
      placePendingActionbar(
        { left: 600, top: 200, bottom: 260, width: 14 },
        { width: 240, height: 82, reach: 82 },
        { width: 1280, height: 212, top: 153 },
        8,
      ),
    ).toBeNull();
  });

  it("caps a tall card whose actions fit between the ruler and the bottom panel", () => {
    expect(
      placePendingActionbar(
        { left: 600, top: 200, bottom: 260, width: 14 },
        { width: 240, height: 600, reach: 82 },
        { width: 1280, height: 400, top: 153 },
        8,
      ),
    ).toEqual({ left: 487, top: 268, maxHeight: 124 });
  });

  it("still places a card that fits between the ruler and the bottom panel", () => {
    expect(
      placePendingActionbar(
        { left: 600, top: 200, bottom: 260, width: 14 },
        { width: 240, height: 82, reach: 82 },
        { width: 1280, height: 400, top: 153 },
        8,
      ),
    ).toEqual({ left: 487, top: 268, maxHeight: 124 });
  });

  it("hides inline controls when neither side has room", () => {
    expect(
      placePendingActionbar(
        { left: 120, top: 8, bottom: 836, width: 14 },
        panel,
        viewport,
        8,
      ),
    ).toBeNull();
  });
});
