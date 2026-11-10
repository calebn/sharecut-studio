import { describe, expect, it } from "vitest";
import { type HandleHintInput, placeHandleHint } from "./handleHintPlace";

const gap = 4;
const base: HandleHintInput = {
  start: { y: 100, height: 20 },
  end: { y: 100, height: 20 },
  view: { top: 0, height: 400 },
  tipHeight: 52,
  reach: 20,
  gap,
};
const put = (over: Partial<HandleHintInput>) =>
  placeHandleHint({ ...base, ...over });

describe("placeHandleHint", () => {
  it("goes under the end grip when it fits on screen", () => {
    expect(put({})).toBe(144);
  });

  it("flips above the start grip when the end sits near the foot of the view", () => {
    expect(
      put({ start: { y: 300, height: 20 }, end: { y: 330, height: 20 } }),
    ).toBe(300 - 20 - 4 - 52);
  });

  it("flips on the visible foot, not the end of the whole text", () => {
    // Text runs on below the view, so the tip under the grip would be clipped.
    expect(put({ view: { top: 0, height: 150 } })).toBe(100 - 20 - 4 - 52);
  });

  it("follows the scroll position", () => {
    expect(
      put({
        view: { top: 500, height: 150 },
        start: { y: 520, height: 20 },
        end: { y: 520, height: 20 },
      }),
    ).toBe(520 + 20 + 20 + 4);
  });

  it("pins inside a body too short for either side, covering the grips least", () => {
    const short = { view: { top: 0, height: 100 } };
    const top = put({
      ...short,
      start: { y: 10, height: 20 },
      end: { y: 10, height: 20 },
    });
    expect(top).not.toBeNull();
    expect(top!).toBeGreaterThanOrEqual(0);
    expect(top! + 52).toBeLessThanOrEqual(100);
    // Grips at the head: the tip takes the foot.
    expect(top).toBe(100 - 52);
    // Grips at the foot: the tip takes the head.
    expect(
      put({
        ...short,
        start: { y: 70, height: 20 },
        end: { y: 70, height: 20 },
      }),
    ).toBe(0);
  });

  it("returns null when the tip is taller than what is on screen", () => {
    expect(put({ view: { top: 0, height: 40 } })).toBeNull();
  });

  it("never returns a tip that leaves the view", () => {
    for (let h = 0; h <= 300; h += 7) {
      for (let y = 0; y <= 300; y += 11) {
        const top = put({
          view: { top: 0, height: h },
          start: { y, height: 20 },
          end: { y, height: 20 },
        });
        if (top !== null) {
          expect(top).toBeGreaterThanOrEqual(0);
          expect(top + 52).toBeLessThanOrEqual(h);
        }
      }
    }
  });
});
