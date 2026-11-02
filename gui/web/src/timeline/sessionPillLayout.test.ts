import { describe, expect, it } from "vitest";
import type { SessionBand } from "./sessionBands";
import { layoutPills, pillWidthPx } from "./sessionPillLayout";

const band = (n: number, start: number, end: number) =>
  ({
    sessionId: `s${n}`,
    number: n,
    label: `S${n}`,
    title: `Session ${n}`,
    start,
    end,
    clipIds: [],
    primary: { id: "c", trackId: "t" },
  }) as SessionBand;

const px10 = (seconds: number) => seconds * 10;
const lefts = (placed: ReturnType<typeof layoutPills>) =>
  placed.map((p) => [p.band.label, p.left]);

describe("layoutPills", () => {
  const w = pillWidthPx("S1");

  it("puts a pill at its band's left edge", () => {
    expect(lefts(layoutPills([band(1, 5, 20)], px10, 500))).toEqual([
      ["S1", 50],
    ]);
  });

  it("keeps back-to-back sessions apart even when the first band is short", () => {
    const placed = layoutPills([band(1, 0, 1), band(2, 1, 9)], px10, 500);
    expect(lefts(placed)).toEqual([
      ["S1", 0],
      ["S2", w + 2],
    ]);
  });

  it("moves a pill right of the previous one when bands overlap", () => {
    const placed = layoutPills([band(1, 0, 30), band(2, 1, 5)], px10, 500);
    expect(placed[1].left).toBe(placed[0].left + w + 2);
  });

  it("pulls a pill left so it stays inside the width at the right edge", () => {
    const placed = layoutPills([band(1, 49, 50)], px10, 500);
    expect(placed[0].left + placed[0].width).toBe(500);
  });

  it("hides a later pill that cannot fit without covering an earlier one", () => {
    const placed = layoutPills([band(1, 48, 49), band(2, 49, 50)], px10, 500);
    expect(placed.map((p) => p.band.label)).toEqual(["S1"]);
    for (const [i, p] of placed.entries()) {
      if (i > 0)
        expect(p.left).toBeGreaterThan(
          placed[i - 1].left + placed[i - 1].width,
        );
    }
  });

  it("skips a band that is outside the window", () => {
    expect(layoutPills([band(1, 100, 120)], px10, 500)).toEqual([]);
  });
});
