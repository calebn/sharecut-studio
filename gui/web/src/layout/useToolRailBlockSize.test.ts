import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolRailInsetRem, useToolRailBlockSize } from "./useToolRailBlockSize";

describe("toolRailInsetRem", () => {
  it("stands the strip clear of the rail on a phone held upright", () => {
    expect(
      toolRailInsetRem({
        viewportPx: 844,
        railPx: 60,
        bottomRowPx: 52,
        rootPx: 16,
      }),
    ).toBe(3.75);
  });

  it("stands it clear on a phone held sideways at the default and a larger text size", () => {
    expect(
      toolRailInsetRem({
        viewportPx: 390,
        railPx: 46,
        bottomRowPx: 28,
        rootPx: 16,
      }),
    ).toBe(2.875);
    expect(
      toolRailInsetRem({
        viewportPx: 390,
        railPx: 66,
        bottomRowPx: 42,
        rootPx: 24,
      }),
    ).toBe(2.75);
  });

  it("leaves the strip over the rail when the screen has less than 10rem for it", () => {
    expect(
      toolRailInsetRem({
        viewportPx: 390,
        railPx: 100,
        bottomRowPx: 56,
        rootPx: 32,
      }),
    ).toBe(0);
  });
});

describe("useToolRailBlockSize", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--tool-rail-block-size");
    document.documentElement.style.removeProperty("--status-height");
    delete document.documentElement.dataset.shell;
    vi.restoreAllMocks();
  });

  it("publishes the rail's height on the root while it is mounted, and takes it back on unmount", () => {
    const root = document.documentElement;
    root.dataset.shell = "tablet";
    root.style.setProperty("--status-height", "1.75rem");
    root.style.fontSize = "16px";
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);
    const rail = document.createElement("div");
    vi.spyOn(rail, "offsetHeight", "get").mockReturnValue(46);
    const { unmount } = renderHook(() =>
      useToolRailBlockSize({ current: rail }),
    );
    window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--tool-rail-block-size")).toBe(
      "2.875rem",
    );
    unmount();
    expect(root.style.getPropertyValue("--tool-rail-block-size")).toBe("");
    root.style.removeProperty("font-size");
  });
});
