import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COARSE_POINTER_MQ } from "../utils/handheldScreen";
import { useHandheldLandscape } from "./useHandheldLandscape";

afterEach(() => vi.unstubAllGlobals());

/** A screen that can change, as on rotation, plus a pointer query that can fire `change`. */
function stubDevice(initial: { coarse: boolean; w: number; h: number }) {
  const state = { ...initial };
  const mqListeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === COARSE_POINTER_MQ && state.coarse;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => mqListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mqListeners.delete(fn),
  }));
  vi.stubGlobal("screen", {
    get width() {
      return state.w;
    },
    get height() {
      return state.h;
    },
  });
  return {
    set(next: Partial<typeof state>) {
      Object.assign(state, next);
    },
    pointerChange() {
      for (const fn of mqListeners) fn();
    },
  };
}

describe("useHandheldLandscape", () => {
  it("is false where matchMedia is missing, as in jsdom", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useHandheldLandscape()).result.current).toBe(false);
  });

  it("re-reads on resize", () => {
    const dev = stubDevice({ coarse: true, w: 390, h: 844 });
    const { result } = renderHook(() => useHandheldLandscape());
    expect(result.current).toBe(true);
    act(() => {
      dev.set({ w: 820, h: 1180 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });

  it("re-reads on orientationchange", () => {
    const dev = stubDevice({ coarse: true, w: 1133, h: 744 });
    const { result } = renderHook(() => useHandheldLandscape());
    expect(result.current).toBe(false);
    act(() => {
      dev.set({ w: 390, h: 844 });
      window.dispatchEvent(new Event("orientationchange"));
    });
    expect(result.current).toBe(true);
  });

  it("re-reads when the pointer query changes", () => {
    const dev = stubDevice({ coarse: true, w: 844, h: 390 });
    const { result } = renderHook(() => useHandheldLandscape());
    expect(result.current).toBe(true);
    act(() => {
      dev.set({ coarse: false });
      dev.pointerChange();
    });
    expect(result.current).toBe(false);
  });

  it("stops listening on unmount", () => {
    const dev = stubDevice({ coarse: true, w: 390, h: 844 });
    const { unmount } = renderHook(() => useHandheldLandscape());
    unmount();
    const spy = vi.spyOn(window, "removeEventListener");
    expect(() => {
      dev.set({ w: 820 });
      window.dispatchEvent(new Event("resize"));
    }).not.toThrow();
    spy.mockRestore();
  });
});
