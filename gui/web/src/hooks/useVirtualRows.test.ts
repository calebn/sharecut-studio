import type { VirtualItem } from "@tanstack/react-virtual";
import { describe, expect, it, vi } from "vitest";
import {
  nextVirtualized,
  VIRTUALIZE_OFF_ROWS,
  VIRTUALIZE_ON_ROWS,
  virtualRowSlotProps,
  withPinnedIndexes,
} from "./useVirtualRows";

describe("nextVirtualized", () => {
  it("switches on at the upper threshold and off below the lower one", () => {
    expect(nextVirtualized(VIRTUALIZE_ON_ROWS, false)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_ON_ROWS - 1, false)).toBe(false);
    expect(nextVirtualized(VIRTUALIZE_ON_ROWS - 1, true)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_OFF_ROWS, true)).toBe(true);
    expect(nextVirtualized(VIRTUALIZE_OFF_ROWS - 1, true)).toBe(false);
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

describe("virtualRowSlotProps", () => {
  it("wires list-item ARIA, measurement, and position", () => {
    const measure = vi.fn();
    const item = {
      index: 4,
      start: 120,
      end: 156,
      size: 36,
      key: "k",
      lane: 0,
    } as VirtualItem;
    expect(virtualRowSlotProps(item, 10, measure)).toEqual({
      role: "listitem",
      "aria-setsize": 10,
      "aria-posinset": 5,
      "data-index": 4,
      ref: measure,
      style: { transform: "translateY(120px)" },
    });
  });
});
