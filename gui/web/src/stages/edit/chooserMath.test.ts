import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHOOSER_CAPTION_HALF_PX,
  CHOOSER_CHIP_PX,
  CHOOSER_EDGE_PX,
  CHOOSER_GAP_PX,
  CHOOSER_MAX_CHIPS,
  CHOOSER_RISE_PX,
  CHOOSER_ROOM_PX,
  CHOOSER_SAG_PX,
  layoutChips,
} from "./chooserMath";

const bounds = { left: 0, top: 0, right: 320, bottom: 600 };
const finger = { x: 160, y: 300 };
const HALF_CHIP = CHOOSER_CHIP_PX / 2;

describe("the chooser's numbers", () => {
  it("are the spec's: 44 px chips 56 px above the finger, 8 px apart, 16 px from the edges, at most five", () => {
    expect(CHOOSER_CHIP_PX).toBe(44);
    expect(CHOOSER_RISE_PX).toBe(56);
    expect(CHOOSER_GAP_PX).toBe(8);
    expect(CHOOSER_EDGE_PX).toBe(16);
    expect(CHOOSER_MAX_CHIPS).toBe(5);
    expect(CHOOSER_SAG_PX).toBe(6);
    expect(CHOOSER_ROOM_PX).toBe(48);
    expect(CHOOSER_CAPTION_HALF_PX).toBe(120);
  });

  it("do not import the legacy timeline layout", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "chooserMath.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from "\.\.\/\.\.\/timeline/);
  });
});

describe("layoutChips", () => {
  it("fans three chips on the arc: the middle one 56 px above the point, the outer ones sagged to 50", () => {
    const { placement, centers } = layoutChips(3, finger, bounds);
    expect(placement).toBe("above");
    expect(centers).toEqual([
      { x: 108, y: 250 },
      { x: 160, y: 244 },
      { x: 212, y: 250 },
    ]);
  });

  it("puts two chips 52 px apart, centred on the point", () => {
    const { centers } = layoutChips(2, finger, bounds);
    expect(centers.map((c) => c.x)).toEqual([134, 186]);
    expect(centers[0].y).toBe(250);
    expect(centers[1].y).toBe(250);
  });

  it("keeps every chip's lower edge at least 28 px above the point, exactly 28 for the outermost of 2 to 5", () => {
    for (const count of [2, 3, 4, 5]) {
      const { centers } = layoutChips(count, finger, bounds);
      for (const c of centers) {
        expect(finger.y - (c.y + HALF_CHIP)).toBeGreaterThanOrEqual(28);
      }
      const lowest = Math.max(...centers.map((c) => c.y));
      expect(finger.y - (lowest + HALF_CHIP)).toBeCloseTo(28, 10);
    }
    const middle = layoutChips(3, finger, bounds).centers[1];
    expect(finger.y - (middle.y + HALF_CHIP)).toBe(34);
  });

  it("keeps the clearance wherever the point is", () => {
    for (const x of [5, 80, 160, 240, 315]) {
      for (const count of [2, 3, 4, 5]) {
        const { placement, centers } = layoutChips(
          count,
          { x, y: 300 },
          bounds,
        );
        expect(placement).toBe("above");
        for (const c of centers) {
          expect(300 - (c.y + HALF_CHIP)).toBeGreaterThanOrEqual(28 - 1e-9);
        }
      }
    }
  });

  it("draws at most five chips", () => {
    expect(layoutChips(8, finger, bounds).centers).toHaveLength(5);
  });

  it("clamps the fan 16 px inside the box at a side edge", () => {
    const left = layoutChips(3, { x: 5, y: 300 }, bounds).centers;
    expect(left[0].x - HALF_CHIP).toBe(16);
    expect(left.map((c) => c.x)).toEqual([38, 90, 142]);
    const right = layoutChips(3, { x: 318, y: 300 }, bounds).centers;
    expect(right[2].x + HALF_CHIP).toBe(320 - 16);
  });

  it("opens below the point when the room above cannot hold the rise, the chip and the caption", () => {
    const need = CHOOSER_RISE_PX + HALF_CHIP + CHOOSER_ROOM_PX;
    expect(need).toBe(126);
    const edge = bounds.top + CHOOSER_EDGE_PX + need;
    expect(layoutChips(3, { x: 160, y: edge }, bounds).placement).toBe("above");
    const below = layoutChips(3, { x: 160, y: edge - 1 }, bounds);
    expect(below.placement).toBe("below");
    expect(below.centers[1].y).toBe(edge - 1 + 56);
    expect(below.centers[0].y).toBe(edge - 1 + 56 - 6);
  });

  it("takes the roomier side when neither holds the fan", () => {
    const short = { left: 0, top: 0, right: 320, bottom: 200 };
    expect(layoutChips(3, { x: 160, y: 120 }, short).placement).toBe("above");
    expect(layoutChips(3, { x: 160, y: 60 }, short).placement).toBe("below");
  });

  it("puts the caption 8 px beyond the arc, on the far side from the point", () => {
    const above = layoutChips(3, finger, bounds);
    expect(above.caption).toEqual({ x: 160, y: 244 - 22 - 8 });
    const below = layoutChips(3, { x: 160, y: 60 }, bounds);
    expect(below.caption).toEqual({ x: 160, y: 60 + 56 + 22 + 8 });
  });

  it("keeps the caption's 240 px width inside the box's 16 px gutters", () => {
    const left = layoutChips(2, { x: 10, y: 300 }, bounds);
    expect(left.caption.x).toBe(120 + 16);
    const right = layoutChips(2, { x: 315, y: 300 }, bounds);
    expect(right.caption.x).toBe(320 - 120 - 16);
  });
});
