import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDevicePixelRatio } from "./useDevicePixelRatio";

describe("useDevicePixelRatio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows devicePixelRatio across resizes and resolution changes", () => {
    const listeners: (() => void)[] = [];
    const queries: string[] = [];
    const remove = vi.fn();
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return {
        media: query,
        matches: true,
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: remove,
      };
    });
    vi.stubGlobal("devicePixelRatio", 1);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(1);
    act(() => {
      vi.stubGlobal("devicePixelRatio", 2);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(2);
    act(() => {
      vi.stubGlobal("devicePixelRatio", 1.5);
      listeners.at(-1)?.();
    });
    expect(result.current).toBe(1.5);
    // Re-armed for the new ratio, the old query released.
    expect(queries.at(-1)).toBe("(resolution: 1.5dppx)");
    expect(remove).toHaveBeenCalled();
  });

  it("falls back to 1 for a missing ratio", () => {
    vi.stubGlobal("devicePixelRatio", 0);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(1);
  });
});
