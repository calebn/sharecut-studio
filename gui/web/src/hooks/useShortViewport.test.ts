import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHORT_VIEWPORT_MQ, useShortViewport } from "./useShortViewport";

function stub(short: boolean, visualHeight?: number) {
  const listeners = new Set<() => void>();
  let isShort = short;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === SHORT_VIEWPORT_MQ && isShort;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  const vvListeners = new Set<() => void>();
  let height = visualHeight;
  vi.stubGlobal("visualViewport", {
    get height() {
      return height;
    },
    addEventListener: (_: string, fn: () => void) => vvListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => vvListeners.delete(fn),
  });
  return {
    setMedia(next: boolean) {
      isShort = next;
      listeners.forEach((fn) => fn());
    },
    setVisual(next: number) {
      height = next;
      vvListeners.forEach((fn) => fn());
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useShortViewport", () => {
  it("is false on a tall window", () => {
    stub(false, 844);
    expect(renderHook(() => useShortViewport()).result.current).toBe(false);
  });

  it("is true when the height media query matches, and follows it", () => {
    const control = stub(true, 900);
    const { result } = renderHook(() => useShortViewport());
    expect(result.current).toBe(true);
    act(() => control.setMedia(false));
    expect(result.current).toBe(false);
  });

  it("is true when the keyboard shrinks the visual viewport, and recovers", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setVisual(340));
    expect(result.current).toBe(true);
    act(() => control.setVisual(480));
    expect(result.current).toBe(true);
    act(() => control.setVisual(568));
    expect(result.current).toBe(false);
  });
});
