import { describe, expect, it } from "vitest";
import {
  clampTabsHeightRem,
  DEFAULT_TABS_HEIGHT_REM,
  initTabsHeight,
  MAX_TABS_FRACTION,
  MIN_TABS_HEIGHT_REM,
  TABS_HEIGHT_STORAGE_KEY,
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

it("normalizes a finite out-of-bounds stored height at admission", () => {
  localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "100");
  const admitted = initTabsHeight();
  expect(admitted).toBeCloseTo(26.1, 5);
  expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBeCloseTo(
    26.1,
    5,
  );
  localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
  document.documentElement.style.removeProperty("--tabs-height");
});
