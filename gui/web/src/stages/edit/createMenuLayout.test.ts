import { describe, expect, it } from "vitest";
import { layoutMenu, naturalSize } from "./createMenuLayout";

describe("layoutMenu", () => {
  const size = { width: 240, height: 218 };
  const viewport = { left: 0, top: 0, right: 844, bottom: 390 };

  it("sits above the point when there is room", () => {
    const bounds = { left: 0, top: 100, right: 390, bottom: 800 };
    expect(layoutMenu({ x: 247, y: 500 }, bounds, size, null)).toEqual({
      placement: "above",
      left: 127,
      top: 258,
      maxHeight: null,
    });
  });

  it("sits below the point near the top of the box", () => {
    const bounds = { left: 0, top: 100, right: 390, bottom: 800 };
    expect(layoutMenu({ x: 247, y: 260 }, bounds, size, null)).toEqual({
      placement: "below",
      left: 127,
      top: 284,
      maxHeight: null,
    });
  });

  it("clamps to a 16 px gutter at the box's side edges", () => {
    const bounds = { left: 0, top: 0, right: 360, bottom: 800 };
    expect(
      layoutMenu({ x: 8, y: 500 }, bounds, { width: 220, height: 200 }, null)
        .left,
    ).toBe(16);
    expect(
      layoutMenu({ x: 352, y: 500 }, bounds, { width: 220, height: 200 }, null)
        .left,
    ).toBe(360 - 16 - 220);
  });

  it("falls back to the viewport when the box is shorter than the menu, below the point rather than over it", () => {
    const bounds = { left: 0, top: 53, right: 844, bottom: 190 };
    expect(
      layoutMenu({ x: 566, y: 116 }, bounds, size, null, viewport),
    ).toEqual({ placement: "below", left: 446, top: 140, maxHeight: null });
  });

  it("goes beside the point when neither above nor below has room", () => {
    const short = { left: 0, top: 0, right: 844, bottom: 260 };
    expect(layoutMenu({ x: 566, y: 130 }, short, size, null)).toEqual({
      placement: "left",
      left: 302,
      top: 21,
      maxHeight: null,
    });
  });

  it("keeps clear of the fixed playhead above the point", () => {
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
    ).toEqual({ placement: "right", left: 424, top: 16, maxHeight: 168 });
  });

  it("goes above or below the point, capped, when it is taller than the screen and too wide to sit beside it", () => {
    const wide = { width: 480, height: 700 };
    expect(layoutMenu({ x: 420, y: 150 }, viewport, wide, null)).toEqual({
      placement: "below",
      left: 180,
      top: 174,
      maxHeight: 200,
    });
    expect(layoutMenu({ x: 420, y: 250 }, viewport, wide, null)).toEqual({
      placement: "above",
      left: 180,
      top: 16,
      maxHeight: 210,
    });
  });

  it("never covers the point, in any geometry that has a free side", () => {
    const covers: string[] = [];
    for (const width of [220, 240, 360, 480, 640, 780]) {
      for (const height of [218, 340, 700]) {
        for (let x = 10; x <= 834; x += 37) {
          for (let y = 10; y <= 380; y += 31) {
            const out = layoutMenu({ x, y }, viewport, { width, height }, null);
            const h = out.maxHeight ?? height;
            const hitsX = x > out.left && x < out.left + width;
            const hitsY = y > out.top && y < out.top + h;
            if (hitsX && hitsY) covers.push(`${width}x${height}@${x},${y}`);
          }
        }
      }
    }
    expect(covers).toEqual([]);
  });

  it("keeps the point a 24 px gap away from the menu wherever it presses", () => {
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

describe("naturalSize", () => {
  it("reads the content height plus the border, not a capped height", () => {
    expect(
      naturalSize({
        offsetWidth: 220,
        offsetHeight: 200,
        clientHeight: 198,
        scrollHeight: 310,
      }),
    ).toEqual({ width: 220, height: 312 });
  });
});
