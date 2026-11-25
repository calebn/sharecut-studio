import { describe, expect, it } from "vitest";
import {
  cardFits,
  detentHeight,
  dragHeight,
  placeCard,
  riseVelocity,
  scaledMinBlock,
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
    const high = { x: 300, y: 60, width: 80, height: 40 };
    expect(placeCard(high, sideways, 640, 320).maxBlock).toBe(240);
  });

  it("opens below an anchor with room, centred on it", () => {
    expect(
      placeCard({ x: 600, y: 100, width: 80, height: 40 }, desktop),
    ).toEqual({
      side: "below",
      inline: 480,
      block: 148,
      maxBlock: 480,
      covered: false,
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
      covered: false,
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
      covered: false,
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
      covered: false,
    });
  });

  it("keeps the card 8 px inside the box when the anchor is outside it", () => {
    expect(
      placeCard({ x: 600, y: -100, width: 80, height: 40 }, desktop),
    ).toEqual({
      side: "below",
      inline: 480,
      block: 8,
      maxBlock: 480,
      covered: false,
    });
    expect(
      placeCard({ x: 600, y: 900, width: 80, height: 40 }, desktop),
    ).toEqual({
      side: "above",
      inline: 480,
      block: 8,
      maxBlock: 480,
      covered: false,
    });
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

  it("keeps a clear card centred on its anchor", () => {
    expect(
      placeCard(
        { x: 140, y: 130, width: 80, height: 40 },
        { width: 820, height: 530 },
        320,
        140,
        [{ x: 540, y: 260, width: 260, height: 54 }],
      ),
    ).toEqual({
      side: "below",
      inline: 20,
      block: 178,
      maxBlock: 318,
      covered: false,
    });
  });

  it("slides left of the corner without changing the card's height or vertical placement", () => {
    expect(
      placeCard(
        { x: 600, y: 130, width: 80, height: 40 },
        { width: 820, height: 530 },
        320,
        140,
        [{ x: 540, y: 260, width: 260, height: 54 }],
      ),
    ).toEqual({
      side: "below",
      inline: 212,
      block: 178,
      maxBlock: 318,
      covered: false,
    });
  });

  it("chooses the closer horizontal position when the card fits on either side", () => {
    expect(
      placeCard({ x: 600, y: 130, width: 80, height: 40 }, desktop, 320, 140, [
        { x: 510, y: 260, width: 250, height: 54 },
      ]),
    ).toEqual({
      side: "below",
      inline: 768,
      block: 178,
      maxBlock: 480,
      covered: false,
    });
  });

  it("caps the card's height above the corner when it cannot fit beside it", () => {
    expect(
      placeCard(
        { x: 200, y: 120, width: 100, height: 20 },
        { width: 500, height: 500 },
        320,
        140,
        [{ x: 160, y: 310, width: 320, height: 58 }],
      ),
    ).toEqual({
      side: "below",
      inline: 90,
      block: 148,
      maxBlock: 154,
      covered: false,
    });
  });

  it("uses the band below the corner when the band above would cover the anchor", () => {
    expect(
      placeCard(
        { x: 200, y: 120, width: 100, height: 40 },
        { width: 500, height: 600 },
        320,
        140,
        [{ x: 100, y: 260, width: 380, height: 70 }],
      ),
    ).toEqual({
      side: "below",
      inline: 90,
      block: 338,
      maxBlock: 254,
      covered: false,
    });
  });

  it("falls to half the minimum above the corner when no band holds a full card", () => {
    expect(
      placeCard(
        { x: 200, y: 120, width: 100, height: 20 },
        { width: 500, height: 430 },
        320,
        140,
        [{ x: 160, y: 125, width: 320, height: 180 }],
      ),
    ).toEqual({
      side: "above",
      inline: 90,
      block: 318,
      maxBlock: 104,
      covered: false,
    });
  });
});

describe("inspectorSheetMath card placement around the Action bar", () => {
  type Box = { x: number; y: number; width: number; height: number };
  const overlap = (
    place: ReturnType<typeof placeCard>,
    bounds: { width: number; height: number },
    obstacle: Box,
  ) => {
    const top =
      place.side === "below"
        ? place.block
        : bounds.height - place.block - place.maxBlock;
    const across =
      Math.min(place.inline + 320, obstacle.x + obstacle.width) -
      Math.max(place.inline, obstacle.x);
    const down =
      Math.min(top + place.maxBlock, obstacle.y + obstacle.height) -
      Math.max(top, obstacle.y);
    return Math.max(0, across) * Math.max(0, down);
  };

  it("slides beside a bar the card's minimum height would cover at 812x375", () => {
    const bounds = { width: 812, height: 326 };
    const bar = { x: 520, y: 145, width: 284, height: 46 };
    expect(placeCard(bar, bounds, 320, 140, [])).toEqual({
      side: "above",
      inline: 192,
      block: 178,
      maxBlock: 140,
      covered: false,
    });
  });

  it("never covers the bar wherever it sits across the 812x375 frame", () => {
    const bounds = { width: 812, height: 326 };
    const covered: number[] = [];
    for (let x = 8; x <= 812 - 284 - 8; x += 4) {
      const bar = { x, y: 145, width: 284, height: 46 };
      if (overlap(placeCard(bar, bounds, 320, 140, []), bounds, bar) > 0) {
        covered.push(x);
      }
    }
    expect(covered).toEqual([]);
  });

  it("gives a mid-frame bar the room above it when no slot beside it holds the card", () => {
    const bounds = { width: 812, height: 326 };
    const bar = { x: 264, y: 145, width: 284, height: 46 };
    expect(placeCard(bar, bounds, 320, 140, [])).toEqual({
      side: "above",
      inline: 246,
      block: 189,
      maxBlock: 129,
      covered: false,
    });
  });

  it("keeps the card on the room around a bar the corner also crowds", () => {
    const bounds = { width: 844, height: 330 };
    const bar = { x: 178.8, y: 140, width: 284, height: 46 };
    const corner = { x: 470.8, y: 251, width: 361.2, height: 54 };
    const placed = placeCard(bar, bounds, 320, 140, [corner]);
    expect(placed).toEqual({
      side: "above",
      inline: 160.8,
      block: 198,
      maxBlock: 124,
      covered: false,
    });
    expect(overlap(placed, bounds, bar)).toBe(0);
    expect(overlap(placed, bounds, corner)).toBe(0);
  });

  it("keeps the normal placement where no room beside or around the bar holds even half a card", () => {
    const bounds = { width: 400, height: 120 };
    const bar = { x: 60, y: 40, width: 284, height: 46 };
    expect(placeCard(bar, bounds, 320, 140, [])).toEqual({
      side: "above",
      inline: 42,
      block: 40,
      maxBlock: 72,
      covered: false,
    });
  });

  it("moves a desktop card off its anchor on a short frame, with no keep-clear area", () => {
    const bounds = { width: 1280, height: 326 };
    const anchor = { x: 700, y: 145, width: 284, height: 46 };
    const placed = placeCard(anchor, bounds);
    expect(placed).toEqual({
      side: "above",
      inline: 372,
      block: 178,
      maxBlock: 140,
      covered: false,
    });
    expect(overlap(placed, bounds, anchor)).toBe(0);
  });
});

describe("inspectorSheetMath card placement around the join band picks", () => {
  type Box = { x: number; y: number; width: number; height: number };
  const WIDTH = 320;
  const EDGE = 8;
  const MIN = 140;
  const GAP = 8;
  // A pick is a thin strip across the lane; it must stay tappable, so the card keeps off it.
  const pick = (x: number, y: number, width = 68, height = 8): Box => ({
    x,
    y,
    width,
    height,
  });
  const boxOf = (
    place: ReturnType<typeof placeCard>,
    bounds: { width: number; height: number },
    width = WIDTH,
  ): Box => ({
    x: place.inline,
    y:
      place.side === "below"
        ? place.block
        : bounds.height - place.block - place.maxBlock,
    width,
    height: place.maxBlock,
  });
  const overlaps = (a: Box, b: Box) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01;
  const insideFrame = (box: Box, bounds: { width: number; height: number }) =>
    box.x >= EDGE - 0.01 &&
    box.y >= EDGE - 0.01 &&
    box.x + box.width <= bounds.width - EDGE + 0.01 &&
    box.y + box.height <= bounds.height - EDGE + 0.01;

  it("reports the common case, with no keep-clear area, as not covered", () => {
    const bounds = { width: 1280, height: 800 };
    const placed = placeCard({ x: 600, y: 100, width: 80, height: 40 }, bounds);
    expect(placed.covered).toBe(false);
  });

  it("leaves the usual placement alone and uncovered when the pick is off the card column", () => {
    const bounds = { width: 844, height: 330 };
    const anchor = { x: 420, y: 40, width: 284, height: 46 };
    expect(placeCard(anchor, bounds, WIDTH, MIN, [pick(258, 200)])).toEqual({
      side: "below",
      inline: 402,
      block: 94,
      maxBlock: 198,
      covered: false,
    });
  });

  it.each([
    { name: "330 px frame, no corner", height: 330, corner: null },
    {
      name: "330 px frame, corner below the strip",
      height: 330,
      corner: { x: 480, y: 250, width: 350, height: 54 },
    },
    {
      name: "390 px frame, no corner",
      height: 390,
      corner: null,
    },
    {
      name: "390 px frame, corner below the strip",
      height: 390,
      corner: { x: 480, y: 310, width: 350, height: 54 },
    },
  ])(
    "keeps the card off the strip and the anchor: $name",
    ({ height, corner }) => {
      const bounds = { width: 844, height };
      const anchor = { x: 100, y: 20, width: 200, height: 30 };
      const strip = pick(150, 140, 70, 8);
      const placed = placeCard(anchor, bounds, WIDTH, MIN, [
        strip,
        ...(corner ? [corner] : []),
      ]);
      const card = boxOf(placed, bounds);
      expect(overlaps(card, strip)).toBe(false);
      expect(overlaps(card, anchor)).toBe(false);
      if (corner) expect(overlaps(card, corner)).toBe(false);
      expect(insideFrame(card, bounds)).toBe(true);
      expect(placed.maxBlock).toBeGreaterThanOrEqual(MIN);
      expect(placed.covered).toBe(false);
    },
  );

  it("places the card below a strip when a corner off the card column would have taken that band", () => {
    const bounds = { width: 844, height: 330 };
    const anchor = { x: 100, y: 20, width: 200, height: 30 };
    const corner = { x: 480, y: 250, width: 350, height: 54 };
    expect(
      placeCard(anchor, bounds, WIDTH, MIN, [pick(150, 140, 70, 8), corner]),
    ).toEqual({
      side: "below",
      inline: 40,
      block: 156,
      maxBlock: 166,
      covered: false,
    });
  });

  it("takes the band the strip leaves with the anchor above it, whatever the root font size", () => {
    const bounds = { width: 844, height: 390 };
    const anchor = { x: 300, y: 20, width: 200, height: 40 };
    const spanning = pick(8, 200, 828, 8);
    for (const rootPx of [16, 22]) {
      const placed = placeCard(anchor, bounds, WIDTH, scaledMinBlock(rootPx), [
        spanning,
      ]);
      const card = boxOf(placed, bounds);
      expect(overlaps(card, spanning)).toBe(false);
      expect(overlaps(card, anchor)).toBe(false);
      expect(insideFrame(card, bounds)).toBe(true);
      expect(placed.covered).toBe(false);
    }
  });

  it("falls to half the minimum at a 22 px root where only that holds a card above a width-spanning pick", () => {
    const bounds = { width: 844, height: 390 };
    const anchor = { x: 300, y: 20, width: 200, height: 40 };
    const placed = placeCard(anchor, bounds, 440, scaledMinBlock(22), [
      pick(8, 200, 828, 8),
    ]);
    expect(placed).toEqual({
      side: "below",
      inline: 180,
      block: 68,
      maxBlock: 124,
      covered: false,
    });
  });

  it("clears a width-spanning pick through the band below it", () => {
    const bounds = { width: 844, height: 390 };
    const anchor = { x: 300, y: 20, width: 200, height: 40 };
    expect(
      placeCard(anchor, bounds, WIDTH, MIN, [pick(8, 200, 828, 8)]),
    ).toEqual({
      side: "below",
      inline: 240,
      block: 216,
      maxBlock: 166,
      covered: false,
    });
  });

  it("keeps the normal placement when the anchor sits inside the only band and the card clears it", () => {
    const bounds = { width: 844, height: 330 };
    const anchor = { x: 300, y: 70, width: 200, height: 46 };
    expect(
      placeCard(anchor, bounds, WIDTH, MIN, [pick(8, 40, 828, 8)]),
    ).toEqual({
      side: "below",
      inline: 240,
      block: 124,
      maxBlock: 198,
      covered: false,
    });
  });

  it("reports covered when no placement holds even half a card clear of the pick", () => {
    const bounds = { width: 844, height: 330 };
    const anchor = { x: 300, y: 20, width: 200, height: 30 };
    const wall = pick(8, 60, 828, 200);
    const placed = placeCard(anchor, bounds, WIDTH, MIN, [wall]);
    expect(placed.covered).toBe(true);
    expect(placed).toMatchObject({ side: "below", inline: 240, block: 58 });
    expect(overlaps(boxOf(placed, bounds), wall)).toBe(true);
  });

  it("reports not covered when the only anchor is the bar in a short frame", () => {
    const bounds = { width: 400, height: 120 };
    const bar = { x: 60, y: 40, width: 284, height: 46 };
    expect(placeCard(bar, bounds, WIDTH, MIN, []).covered).toBe(false);
  });

  it("slides a non-bleed card beside the corner when only the corner is kept clear", () => {
    const bounds = { width: 844, height: 330 };
    const bar = { x: 540, y: 20, width: 200, height: 30 };
    const corner = { x: 480, y: 250, width: 350, height: 54 };
    expect(placeCard(bar, bounds, WIDTH, MIN, [corner])).toEqual({
      side: "below",
      inline: 152,
      block: 58,
      maxBlock: 198,
      covered: false,
    });
  });

  it("keeps the gap between the card and a pick it was moved off", () => {
    const bounds = { width: 844, height: 390 };
    const anchor = { x: 300, y: 20, width: 200, height: 40 };
    const spanning = pick(8, 200, 828, 8);
    const card = boxOf(
      placeCard(anchor, bounds, WIDTH, MIN, [spanning]),
      bounds,
    );
    expect(card.y - (spanning.y + spanning.height)).toBeGreaterThanOrEqual(
      GAP - 0.01,
    );
  });
});
