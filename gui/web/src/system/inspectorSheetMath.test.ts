import { describe, expect, it } from "vitest";
import {
  cardFits,
  detentHeight,
  dragHeight,
  placeCard,
  riseVelocity,
  settleDetent,
  steppedDetent,
  toggledDetent,
} from "./inspectorSheetMath";

describe("inspectorSheetMath detents", () => {
  it("is 64 px at the dock, 50 % at half and 92 % at full", () => {
    expect(
      ["dock", "half", "full"].map((d) => detentHeight(d as never, 800)),
    ).toEqual([64, 400, 736]);
  });

  it("follows the finger from the start height and stops at full and at nothing", () => {
    expect(dragHeight(64, -100, 800)).toBe(164);
    expect(dragHeight(400, 150, 800)).toBe(250);
    expect(dragHeight(400, -900, 800)).toBe(736);
    expect(dragHeight(64, 200, 800)).toBe(0);
  });

  it("settles on the nearest detent when let go slowly", () => {
    expect(settleDetent(70, 0, 800)).toBe("dock");
    expect(settleDetent(300, 0, 800)).toBe("half");
    expect(settleDetent(560, 0, 800)).toBe("half");
    expect(settleDetent(570, 0, 800)).toBe("full");
    expect(settleDetent(736, 0, 800)).toBe("full");
  });

  it("carries a flick 120 ms ahead", () => {
    expect(settleDetent(200, 1.5, 800)).toBe("half");
    expect(settleDetent(120, 1.5, 800)).toBe("half");
    expect(settleDetent(400, 2, 800)).toBe("full");
    expect(settleDetent(400, -1, 800)).toBe("half");
    expect(settleDetent(400, -2.5, 800)).toBe("dock");
  });

  it("dismisses when let go more than 24 px below the dock, or flicked down from the dock", () => {
    expect(settleDetent(41, 0, 800)).toBe("dock");
    expect(settleDetent(39, 0, 800)).toBe("dismiss");
    expect(settleDetent(0, 0, 800)).toBe("dismiss");
    expect(settleDetent(64, -0.1, 800, true)).toBe("dock");
    expect(settleDetent(64, -0.3, 800, true)).toBe("dismiss");
  });

  it("takes the measured dock height, as at a 20 px root where the 4 rem dock is 80 px", () => {
    expect(detentHeight("dock", 800, 80)).toBe(80);
    expect(detentHeight("half", 800, 80)).toBe(400);
    expect(settleDetent(79, 0, 800, false, 80)).toBe("dock");
    expect(settleDetent(55, 0, 800, false, 80)).toBe("dismiss");
    expect(settleDetent(55, 0, 800)).toBe("dock");
    expect(settleDetent(80, -0.1, 800, true, 80)).toBe("dock");
    expect(settleDetent(80, -0.3, 800, true, 80)).toBe("dismiss");
    expect(settleDetent(80, -0.3, 800, true)).toBe("dock");
  });

  it("lands a flick down from higher up on the dock instead of dismissing", () => {
    expect(settleDetent(260, -2, 640)).toBe("dock");
    expect(settleDetent(300, -3, 640)).toBe("dock");
    expect(settleDetent(100, -4, 640)).toBe("dock");
    expect(settleDetent(100, -4, 640, true)).toBe("dismiss");
  });

  it("reads the rise velocity across the last 100 ms of samples", () => {
    expect(riseVelocity([], 0)).toBe(0);
    expect(riseVelocity([{ t: 0, height: 64 }], 0)).toBe(0);
    const samples = [
      { t: 0, height: 64 },
      { t: 10, height: 94 },
      { t: 20, height: 154 },
    ];
    expect(riseVelocity(samples, 20)).toBe(4.5);
    expect(
      riseVelocity(
        [
          { t: 5, height: 100 },
          { t: 5, height: 90 },
        ],
        5,
      ),
    ).toBe(0);
    expect(riseVelocity(samples, 100)).toBe(4.5);
    expect(riseVelocity(samples, 101)).toBe(0);
  });

  it("does not read two moves handled back to back as a huge flick", () => {
    const steady = [
      { t: 0, height: 700 },
      { t: 60, height: 662 },
      { t: 120, height: 625 },
      { t: 180, height: 587 },
      { t: 185, height: 550 },
    ];
    expect(riseVelocity(steady, 185)).toBeCloseTo(-75 / 65, 10);
    expect(settleDetent(550, riseVelocity(steady, 185), 760)).toBe("half");
  });

  it("only looks back 100 ms", () => {
    const samples = [
      { t: 0, height: 0 },
      { t: 120, height: 500 },
      { t: 190, height: 520 },
      { t: 200, height: 510 },
    ];
    expect(riseVelocity(samples, 200)).toBe(0.125);
  });

  it("toggles half and dock, steps full down to half, and steps one detent held at the ends", () => {
    expect([
      toggledDetent("dock"),
      toggledDetent("half"),
      toggledDetent("full"),
    ]).toEqual(["half", "dock", "half"]);
    expect(steppedDetent("dock", 1)).toBe("half");
    expect(steppedDetent("half", 1)).toBe("full");
    expect(steppedDetent("full", 1)).toBe("full");
    expect(steppedDetent("dock", -1)).toBe("dock");
    expect(steppedDetent("full", -1)).toBe("half");
  });
});

describe("inspectorSheetMath cardFits", () => {
  it("fits a card whose 60 % holds the minimum, and counts an unmeasured frame as fitting", () => {
    expect(cardFits(234)).toBe(true);
    expect(cardFits(233)).toBe(false);
    expect(cardFits(0)).toBe(true);
    expect(cardFits(466, 280)).toBe(false);
    expect(cardFits(467, 280)).toBe(true);
  });
});

describe("inspectorSheetMath card placement", () => {
  const desktop = { width: 1280, height: 800 };

  it("keeps a floor under the card where both sides are short, covering the anchor", () => {
    const sideways = { width: 740, height: 300 };
    const placed = placeCard(
      { x: 300, y: 130, width: 80, height: 40 },
      sideways,
    );
    expect(placed.maxBlock).toBe(140);
    expect(placed.block).toBeGreaterThanOrEqual(8);
    expect(placed.block + placed.maxBlock).toBeLessThanOrEqual(300 - 8 + 0.001);
  });

  it("leaves a card alone where the room already holds the floor, and never passes 60 % of the frame", () => {
    const sideways = { width: 1000, height: 400 };
    const anchor = { x: 300, y: 180, width: 80, height: 40 };
    expect(placeCard(anchor, sideways, 320).maxBlock).toBe(164);
    expect(placeCard(anchor, sideways, 640, 320).maxBlock).toBe(240);
  });

  it("opens below an anchor with room, centred on it", () => {
    expect(
      placeCard({ x: 600, y: 100, width: 80, height: 40 }, desktop),
    ).toEqual({
      side: "below",
      inline: 480,
      block: 148,
      maxBlock: 480,
    });
  });

  it("opens below a pin-sized anchor in the top marker lane with real height", () => {
    const placed = placeCard(
      { x: 360, y: 30, width: 44, height: 24 },
      {
        width: 1100,
        height: 700,
      },
    );
    expect(placed.side).toBe("below");
    expect(placed.maxBlock).toBeGreaterThan(100);
  });

  it("keeps a card wider than 320 px, as at a larger text size, inside the box", () => {
    const tablet = { width: 820, height: 1180 };
    expect(
      placeCard({ x: 700, y: 100, width: 80, height: 40 }, tablet, 640).inline,
    ).toBe(172);
  });

  it("flips above when the card does not fit below, hanging from the anchor's top", () => {
    expect(
      placeCard({ x: 600, y: 600, width: 80, height: 40 }, desktop),
    ).toEqual({
      side: "above",
      inline: 480,
      block: 208,
      maxBlock: 480,
    });
  });

  it("takes the side with more room and shortens the card to it", () => {
    expect(
      placeCard(
        { x: 100, y: 300, width: 40, height: 40 },
        { width: 800, height: 700 },
      ),
    ).toEqual({
      side: "below",
      inline: 8,
      block: 348,
      maxBlock: 344,
    });
    expect(
      placeCard(
        { x: 100, y: 360, width: 40, height: 40 },
        { width: 800, height: 700 },
      ),
    ).toEqual({
      side: "above",
      inline: 8,
      block: 348,
      maxBlock: 344,
    });
  });

  it("keeps the card 8 px inside the box when the anchor is outside it", () => {
    expect(
      placeCard({ x: 600, y: -100, width: 80, height: 40 }, desktop),
    ).toEqual({ side: "below", inline: 480, block: 8, maxBlock: 480 });
    expect(
      placeCard({ x: 600, y: 900, width: 80, height: 40 }, desktop),
    ).toEqual({ side: "above", inline: 480, block: 8, maxBlock: 480 });
  });

  it("keeps the card 8 px inside the right edge and fits a narrow viewport", () => {
    expect(
      placeCard({ x: 1240, y: 100, width: 30, height: 40 }, desktop).inline,
    ).toBe(952);
    expect(
      placeCard(
        { x: 200, y: 100, width: 30, height: 40 },
        { width: 360, height: 700 },
      ).inline,
    ).toBe(32);
    expect(
      placeCard(
        { x: 0, y: 100, width: 30, height: 40 },
        { width: 300, height: 700 },
      ).inline,
    ).toBe(8);
  });
});
