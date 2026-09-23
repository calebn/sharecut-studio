import { describe, expect, it } from "vitest";
import {
  nextVirtualized,
  VIRTUALIZE_OFF_TURNS,
  VIRTUALIZE_ON_TURNS,
  withPinnedIndexes,
} from "./useVirtualTurns";

describe("nextVirtualized", () => {
  it("switches on at the upper threshold and off below the lower one", () => {
    expect(nextVirtualized(VIRTUALIZE_ON_TURNS, false)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_ON_TURNS - 1, false)).toBe(false);
    expect(nextVirtualized(VIRTUALIZE_ON_TURNS - 1, true)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_OFF_TURNS, true)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_OFF_TURNS - 1, true)).toBe(false);
  });
});

describe("withPinnedIndexes", () => {
  const range = { startIndex: 10, endIndex: 12, overscan: 1, count: 100 };

  it("returns the overscanned range when nothing extra is pinned", () => {
    expect(withPinnedIndexes(range, [])).toEqual([9, 10, 11, 12, 13]);
    expect(withPinnedIndexes(range, [11])).toEqual([9, 10, 11, 12, 13]);
  });

  it("adds in-bounds pinned indexes sorted and unique", () => {
    expect(withPinnedIndexes(range, [90, 2, 90, -1, 100])).toEqual([
      2, 9, 10, 11, 12, 13, 90,
    ]);
  });
});
