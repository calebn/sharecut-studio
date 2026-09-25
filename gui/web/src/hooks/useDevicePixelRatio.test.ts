import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDevicePixelRatio } from "./useDevicePixelRatio";

describe("useDevicePixelRatio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows devicePixelRatio across resizes and resolution changes", () => {
    const listeners: (() => void)[] = [];
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches: true,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    }));
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
  });

  it("falls back to 1 for a missing ratio", () => {
    vi.stubGlobal("devicePixelRatio", 0);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(1);
  });
});
