import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHORT_VIEWPORT_MQ, useShortViewport } from "./useShortViewport";

function stub(short: boolean, visualHeight?: number, visualScale = 1) {
  const mediaListeners = new Set<() => void>();
  let isShort = short;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === SHORT_VIEWPORT_MQ && isShort;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) =>
      mediaListeners.delete(fn),
  }));
  const addWindow = vi.spyOn(window, "addEventListener");
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const vvListeners = new Set<() => void>();
  let height = visualHeight;
  let scale = visualScale;
  const vvEvents: string[] = [];
  vi.stubGlobal("visualViewport", {
    get height() {
      return height;
    },
    get scale() {
      return scale;
    },
    addEventListener: (type: string, fn: () => void) => {
      vvEvents.push(`add:${type}`);
      vvListeners.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      vvEvents.push(`remove:${type}`);
      vvListeners.delete(fn);
    },
  });
  return {
    setMedia(next: boolean) {
      isShort = next;
      mediaListeners.forEach((fn) => fn());
    },
    setScale(next: number) {
      scale = next;
      vvListeners.forEach((fn) => fn());
    },
    vvEvents,
    addWindow,
    removeWindow,
    setVisual(next: number) {
      height = next;
      vvListeners.forEach((fn) => fn());
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("matches the height media query at 30rem", () => {
    expect(SHORT_VIEWPORT_MQ).toBe("(max-height: 30rem)");
  });

  it("is false at a visual height of 481 on a tall window", () => {
    stub(false, 481);
    expect(renderHook(() => useShortViewport()).result.current).toBe(false);
  });

  it("is false with no matchMedia on a tall viewport", () => {
    stub(false, 844);
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useShortViewport()).result.current).toBe(false);
  });

  it("keeps the Script while pinch-zoomed even though the visual height shrank", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setScale(1.5));
    act(() => control.setVisual(440));
    expect(result.current).toBe(false);
    act(() => control.setScale(1));
    expect(result.current).toBe(true);
  });

  it("does not flip back until the visual height recovers to 520", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setVisual(460));
    expect(result.current).toBe(true);
    act(() => control.setVisual(500));
    expect(result.current).toBe(true);
    act(() => control.setVisual(519));
    expect(result.current).toBe(true);
    act(() => control.setVisual(520));
    expect(result.current).toBe(false);
    act(() => control.setVisual(500));
    expect(result.current).toBe(false);
  });

  it("counts a visual height of exactly 480 as short from a fresh start", () => {
    stub(false, 480);
    expect(renderHook(() => useShortViewport()).result.current).toBe(true);
  });

  it("forgets the short state when pinch-zoom starts", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setVisual(440));
    expect(result.current).toBe(true);
    act(() => control.setScale(1.5));
    act(() => control.setVisual(500));
    act(() => control.setScale(1));
    expect(result.current).toBe(false);
  });

  it("is false with no visual viewport on a tall window", () => {
    stub(false, 844);
    vi.stubGlobal("visualViewport", undefined);
    expect(renderHook(() => useShortViewport()).result.current).toBe(false);
  });

  it("treats a missing visual height as not short", () => {
    stub(false, undefined);
    expect(renderHook(() => useShortViewport()).result.current).toBe(false);
  });

  it("treats a scale within 0.01 of 1 as unzoomed and a scale of 1.02 as zoomed", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setScale(1.005));
    act(() => control.setVisual(440));
    expect(result.current).toBe(true);
    act(() => control.setVisual(844));
    act(() => control.setScale(1.02));
    act(() => control.setVisual(440));
    expect(result.current).toBe(false);
  });

  it("stops reporting short when the visual height goes missing", () => {
    const control = stub(false, 440);
    const { result } = renderHook(() => useShortViewport());
    expect(result.current).toBe(true);
    act(() => control.setVisual(undefined as unknown as number));
    expect(result.current).toBe(false);
  });

  it("still follows the height media query while pinch-zoomed", () => {
    const control = stub(false, 844);
    const { result } = renderHook(() => useShortViewport());
    act(() => control.setScale(1.5));
    act(() => control.setMedia(true));
    expect(result.current).toBe(true);
  });

  it("listens for resize on the window and on the visual viewport, and lets go on unmount", () => {
    const control = stub(false, 844);
    const { unmount } = renderHook(() => useShortViewport());
    expect(control.addWindow.mock.calls.map(([type]) => type)).toContain(
      "resize",
    );
    expect(control.vvEvents).toEqual(["add:resize"]);
    unmount();
    expect(control.removeWindow.mock.calls.map(([type]) => type)).toContain(
      "resize",
    );
    expect(control.vvEvents).toEqual(["add:resize", "remove:resize"]);
  });
});
