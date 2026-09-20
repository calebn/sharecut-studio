import { describe, expect, it } from "vitest";
import {
  clampTabsHeightRem,
  DEFAULT_TABS_HEIGHT_REM,
  MAX_TABS_FRACTION,
  MIN_TABS_HEIGHT_REM,
} from "./useTabsHeight";

describe("clampTabsHeightRem", () => {
  it("clamps below min", () => {
    expect(clampTabsHeightRem(2, 1000)).toBe(MIN_TABS_HEIGHT_REM);
  });

  it("clamps above max fraction of available space", () => {
    const avail = 1000;
    const maxRem = (avail * MAX_TABS_FRACTION) / 16;
    expect(clampTabsHeightRem(99, avail)).toBeCloseTo(maxRem, 5);
  });

  it("keeps a mid value", () => {
    expect(clampTabsHeightRem(DEFAULT_TABS_HEIGHT_REM, 2000)).toBe(
      DEFAULT_TABS_HEIGHT_REM,
    );
  });

  it("falls back for non-finite input", () => {
    expect(clampTabsHeightRem(Number.NaN, 1000)).toBe(DEFAULT_TABS_HEIGHT_REM);
  });
});
