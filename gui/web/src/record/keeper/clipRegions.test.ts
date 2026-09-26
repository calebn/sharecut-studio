import { describe, expect, it } from "vitest";
import {
  ClipRegionTracker,
  MAX_CLIP_REGIONS,
  parseClipRegions,
  serializeClipRegions,
  takeRelativeMs,
} from "./clipRegions";
import { KEEPER_SAMPLE_RATE } from "./pcm";

const ms = (n: number) => Math.round((n * KEEPER_SAMPLE_RATE) / 1000);

describe("ClipRegionTracker", () => {
  it("opens a region and floors start / ceils end", () => {
    const t = new ClipRegionTracker();
    expect(t.observe(ms(100) + 1, ms(150))).toBe(true);
    expect(t.regionsMs()).toEqual([{ startMs: 100, endMs: 151 }]);
  });

  it("gives a single sample at least 1 ms", () => {
    const t = new ClipRegionTracker();
    t.observe(0, 0);
    expect(t.regionsMs()).toEqual([{ startMs: 0, endMs: 1 }]);
  });

  it("merges hits less than one second apart", () => {
    const t = new ClipRegionTracker();
    expect(t.observe(ms(0), ms(10))).toBe(true);
    expect(t.observe(ms(1010), ms(1020))).toBe(true);
    expect(t.observe(ms(1030), ms(1040))).toBe(false);
    expect(t.observe(ms(2100), ms(2110))).toBe(true);
    expect(t.regionsMs().map((r) => [r.startMs, r.endMs])).toEqual([
      [0, 1041],
      [2100, 2111],
    ]);
  });

  it("re-notifies when the open region grows by the emit step", () => {
    const t = new ClipRegionTracker();
    expect(t.observe(ms(0), ms(10))).toBe(true);
    expect(t.observe(ms(100), ms(200))).toBe(false);
    expect(t.observe(ms(300), ms(400))).toBe(true);
  });

  it("stops at the cap and marks the segment truncated", () => {
    const t = new ClipRegionTracker();
    for (let i = 0; i < MAX_CLIP_REGIONS; i++) {
      expect(t.observe(ms(i * 5000), ms(i * 5000 + 10))).toBe(true);
    }
    expect(t.truncated).toBe(false);
    const lastStart = (MAX_CLIP_REGIONS - 1) * 5000;
    t.observe(ms(lastStart + 20), ms(lastStart + 30));
    expect(t.observe(ms(lastStart + 60_000), ms(lastStart + 60_010))).toBe(
      true,
    );
    expect(t.truncated).toBe(true);
    expect(t.observe(ms(lastStart + 90_000), ms(lastStart + 90_010))).toBe(
      false,
    );
    const out = t.regionsMs();
    expect(out).toHaveLength(MAX_CLIP_REGIONS);
    expect(out[out.length - 1]).toEqual({
      startMs: lastStart,
      endMs: lastStart + 31,
    });
  });

  it("keeps merging a dense burst into the last region after the cap without truncating", () => {
    const t = new ClipRegionTracker();
    for (let i = 0; i < MAX_CLIP_REGIONS; i++) {
      t.observe(ms(i * 5000), ms(i * 5000 + 10));
    }
    const lastStart = (MAX_CLIP_REGIONS - 1) * 5000;
    // Each hit starts 900 ms after the previous one ends, so every hit merges.
    let end = lastStart + 10;
    for (let k = 0; k < 10; k++) {
      const start = end + 900;
      end = start + 10;
      t.observe(ms(start), ms(end));
    }
    expect(t.truncated).toBe(false);
    const out = t.regionsMs();
    expect(out).toHaveLength(MAX_CLIP_REGIONS);
    expect(out[out.length - 1]).toEqual({ startMs: lastStart, endMs: end + 1 });
  });

  it("resets", () => {
    const t = new ClipRegionTracker();
    t.observe(1, 2);
    t.reset();
    expect(t.regionsMs()).toEqual([]);
    expect(t.truncated).toBe(false);
  });
});

describe("serialize / parse", () => {
  it("serializes as a-b,c-d", () => {
    expect(
      serializeClipRegions([
        { startMs: 1, endMs: 2 },
        { startMs: 5, endMs: 9 },
      ]),
    ).toBe("1-2,5-9");
  });

  it("accepts valid regions and empty arrays", () => {
    expect(parseClipRegions([])).toEqual([]);
    expect(parseClipRegions([{ startMs: 0, endMs: 5 }])).toEqual([
      { startMs: 0, endMs: 5 },
    ]);
  });

  it.each([
    ["non-array", {}],
    ["non-int", [{ startMs: 0.5, endMs: 5 }]],
    ["negative", [{ startMs: -1, endMs: 5 }]],
    ["start >= end", [{ startMs: 5, endMs: 5 }]],
    [
      "unsorted",
      [
        { startMs: 10, endMs: 20 },
        { startMs: 5, endMs: 8 },
      ],
    ],
    ["not an object", [3]],
    [
      "too many",
      Array.from({ length: MAX_CLIP_REGIONS + 1 }, (_, i) => ({
        startMs: i * 2,
        endMs: i * 2 + 1,
      })),
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseClipRegions(value)).toBeNull();
  });
});

describe("takeRelativeMs", () => {
  it("applies the join offset and keeps the segment start", () => {
    expect(takeRelativeMs(2, 5000, [{ startMs: 100, endMs: 200 }])).toEqual([
      { segmentIndex: 2, startMs: 5100, endMs: 5200, segmentStartMs: 100 },
    ]);
  });
});
