import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dropCollidingRulerEndTick,
  estimateRulerLabelWidthPx,
} from "./rulerTicks";

describe("dropCollidingRulerEndTick", () => {
  it("keeps every tick when the end label has room", () => {
    // 60s at 100px/s: ticks every 2s (200px apart), plenty of room.
    const ticks = [0, 2, 4, 58, 60];
    expect(dropCollidingRulerEndTick(ticks, 100, 6000, 44)).toEqual(ticks);
  });

  it("drops the final tick when its end-aligned label would collide (#169)", () => {
    // ~10s phone timeline: ticks every 2s at 80px; the 0:08 label
    // right-aligns near the edge and would overlap 0:06.
    const ticks = [0, 2, 4, 6, 8];
    expect(dropCollidingRulerEndTick(ticks, 40, 360, 44)).toEqual([0, 2, 4, 6]);
  });

  it("keeps the final tick when the gap fits both labels", () => {
    const ticks = [0, 2, 4, 6, 8];
    expect(dropCollidingRulerEndTick(ticks, 40, 360, 34)).toEqual(ticks);
  });

  it("keeps the final tick when it is not near the right edge", () => {
    // Last tick far from the edge: left-aligned, no collision possible.
    const ticks = [0, 2, 4, 6, 8];
    expect(dropCollidingRulerEndTick(ticks, 40, 1000, 44)).toEqual(ticks);
  });

  it("keeps a single tick", () => {
    expect(dropCollidingRulerEndTick([0], 40, 360, 44)).toEqual([0]);
  });

  it("does not drop when the last tick is at time zero", () => {
    // t > 0 guard mirrors the end-alignment rule.
    expect(dropCollidingRulerEndTick([0], 40, 40, 44)).toEqual([0]);
  });
});

describe("estimateRulerLabelWidthPx", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a tight estimate on desktop (fine pointer)", () => {
    // jsdom has no matchMedia: treated as fine pointer.
    expect(estimateRulerLabelWidthPx([0, 2, 4, 6, 8])).toBe(4 * 6 + 10);
  });

  it("uses a generous estimate on touch devices (coarse pointer)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
    }));
    expect(estimateRulerLabelWidthPx([0, 2, 4, 6, 8])).toBe(4 * 8 + 12);
  });
});
