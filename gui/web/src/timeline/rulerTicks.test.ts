import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";
import {
  estimateRulerLabelWidthPx,
  rulerEndTickDropped,
  rulerTickIndices,
} from "./rulerTicks";

describe("rulerTickIndices", () => {
  it("covers [0, duration] in the chunks asked, never past duration", () => {
    // 95 s at 10 px/s, 10 s steps: 950 px, one chunk.
    expect(rulerTickIndices([0, 0], 10, 10, 95)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("ticks through empty canvas past a short session", () => {
    const ticks = rulerTickIndices([0, 0], 10, 10, 100).map((i) => i * 10);
    expect(Math.max(...ticks)).toBe(100);
  });

  it("mounts only the chunks on screen at deep zoom", () => {
    // 60 s at 48,000 px/s with 2 ms steps (96 px): 30,000 ticks in all.
    const zoom = 48000;
    const step = 0.002;
    const all = Math.floor(60 / step) + 1;
    const shown = rulerTickIndices([100, 101], step, zoom, 60);
    expect(shown.length).toBeLessThanOrEqual(
      Math.ceil((2 * VIEWPORT_CHUNK_PX) / (step * zoom)) + 1,
    );
    expect(shown.length).toBeLessThan(all / 100);
    // Every tick is inside the two chunks, and positions are i·step.
    for (const i of shown) {
      const x = i * step * zoom;
      expect(x).toBeGreaterThanOrEqual(100 * VIEWPORT_CHUNK_PX);
      expect(x).toBeLessThan(102 * VIEWPORT_CHUNK_PX);
    }
    expect(shown[1]! - shown[0]!).toBe(1);
  });

  it("is empty for a bad step or zoom", () => {
    expect(rulerTickIndices([0, 0], 0, 10, 10)).toEqual([]);
    expect(rulerTickIndices([0, 0], 1, 0, 10)).toEqual([]);
  });
});

describe("rulerEndTickDropped", () => {
  it("keeps the end tick when its label has room", () => {
    expect(rulerEndTickDropped(60, 2, 100, 6000, 44)).toBe(false);
  });

  it("drops the end tick when its right-aligned label would collide (#169)", () => {
    // ~9 s phone timeline: 2 s ticks 80 px apart; the 8 s label right-aligns
    // near the 360 px edge and would overlap the 6 s label.
    expect(rulerEndTickDropped(9, 2, 40, 360, 44)).toBe(true);
    expect(rulerEndTickDropped(9, 2, 40, 360, 34)).toBe(false);
  });

  it("keeps an end tick far from the edge, or at time zero", () => {
    expect(rulerEndTickDropped(9, 2, 40, 1000, 44)).toBe(false);
    expect(rulerEndTickDropped(0.5, 2, 40, 40, 44)).toBe(false);
  });
});

describe("estimateRulerLabelWidthPx", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a tight estimate on desktop (fine pointer)", () => {
    // jsdom has no matchMedia: treated as a fine pointer. "0:08".
    expect(estimateRulerLabelWidthPx(8, 2)).toBe(4 * 6 + 10);
    // "0:08.002": deep-zoom labels are wider.
    expect(estimateRulerLabelWidthPx(8.002, 0.002)).toBe(8 * 6 + 10);
  });

  it("uses a generous estimate on touch devices (coarse pointer)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
    }));
    expect(estimateRulerLabelWidthPx(8, 2)).toBe(4 * 8 + 12);
  });
});
