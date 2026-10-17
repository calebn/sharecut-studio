import fs from "node:fs";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  clampTabsHeightRem,
  DEFAULT_TABS_HEIGHT_REM,
  initTabsHeight,
  MAX_TABS_FRACTION,
  MIN_TABS_HEIGHT_REM,
  minTabsHeightRem,
  SHORT_DEFAULT_TABS_FRACTION,
  SHORT_MIN_TABS_HEIGHT_REM,
  TABS_HEIGHT_STORAGE_KEY,
  useTabsHeight,
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

  it("lets a short viewport shrink its panel below the default, to 4.5rem", () => {
    // A 331px-tall window leaves 259px under the transport and status rows;
    // the CSS default there is 38% of it (6.15rem), under the 8rem floor.
    const avail = 259;
    const shortDefaultRem = (avail * 0.38) / 16;
    expect(shortDefaultRem).toBeLessThan(MIN_TABS_HEIGHT_REM);
    expect(minTabsHeightRem(avail)).toBe(4.5);
    expect(clampTabsHeightRem(0, avail)).toBe(4.5);
    expect(clampTabsHeightRem(shortDefaultRem, avail)).toBeCloseTo(
      shortDefaultRem,
      5,
    );
    expect(clampTabsHeightRem(99, avail)).toBeCloseTo((avail * 0.6) / 16, 5);
  });

  it("never puts the floor above a very short window's own default", () => {
    const avail = 100;
    const shortDefaultRem = (avail * 0.38) / 16;
    expect(minTabsHeightRem(avail)).toBeCloseTo(shortDefaultRem, 5);
  });

  it("keeps the 8rem floor where the viewport is tall", () => {
    expect(minTabsHeightRem(1000)).toBe(MIN_TABS_HEIGHT_REM);
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

describe("a window with no measurable height", () => {
  it("keeps a positive floor and clamp", () => {
    expect(minTabsHeightRem(0)).toBeGreaterThan(0);
    expect(clampTabsHeightRem(12, 0)).toBeGreaterThan(0);
  });

  it("leaves a stored height alone when the window reports zero height", () => {
    localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "10");
    const heightSpy = vi.spyOn(window, "innerHeight", "get").mockReturnValue(0);
    try {
      expect(initTabsHeight()).toBe(10);
      expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("10");
    } finally {
      heightSpy.mockRestore();
      localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
      document.documentElement.style.removeProperty("--tabs-height");
    }
  });
});

describe("the mounted hook in a window with no measurable height", () => {
  it("keeps the stored height through mount and resize", () => {
    localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "10");
    const heightSpy = vi.spyOn(window, "innerHeight", "get").mockReturnValue(0);
    try {
      const { result, unmount } = renderHook(() => useTabsHeight());
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(result.current.heightRem).toBe(10);
      expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("10");
      unmount();
    } finally {
      heightSpy.mockRestore();
      localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
      document.documentElement.style.removeProperty("--tabs-height");
    }
  });
});

describe("the short window default", () => {
  const responsiveCss = fs.readFileSync(
    path.join(process.cwd(), "src/styles/partials/responsive.css"),
    "utf8",
  );
  const shortBlock = responsiveCss.slice(
    responsiveCss.indexOf("Short viewport: prefer timeline"),
  );

  it("takes the fraction of the space the hook's floor assumes", () => {
    const fraction = /\*\s*(0\.\d+)\s*\)/.exec(shortBlock)?.[1];
    expect(Number(fraction)).toBe(SHORT_DEFAULT_TABS_FRACTION);
  });

  it("caps at the regular default height", () => {
    const cap = /min\(\s*([\d.]+)rem/.exec(shortBlock)?.[1];
    expect(Number(cap)).toBe(DEFAULT_TABS_HEIGHT_REM);
  });

  it("keeps the short floor under the regular floor", () => {
    expect(SHORT_MIN_TABS_HEIGHT_REM).toBeLessThan(MIN_TABS_HEIGHT_REM);
  });
});
