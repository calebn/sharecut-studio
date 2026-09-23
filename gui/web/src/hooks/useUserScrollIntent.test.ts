import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent, PointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isScrollKey,
  USER_SCROLL_INTENT_MS,
  useUserScrollIntent,
} from "./useUserScrollIntent";

describe("isScrollKey", () => {
  it("accepts page keys anywhere and arrows/space only on the container", () => {
    expect(isScrollKey("PageDown", false)).toBe(true);
    expect(isScrollKey("End", false)).toBe(true);
    expect(isScrollKey("ArrowDown", false)).toBe(false);
    expect(isScrollKey("ArrowDown", true)).toBe(true);
    expect(isScrollKey(" ", true)).toBe(true);
    expect(isScrollKey("a", true)).toBe(false);
  });
});

describe("useUserScrollIntent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats scrolls as user scrolls only shortly after input", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUserScrollIntent());
    expect(result.current.isUserScroll()).toBe(false);
    act(() => result.current.handlers.onWheel());
    expect(result.current.isUserScroll()).toBe(true);
    vi.advanceTimersByTime(USER_SCROLL_INTENT_MS + 1);
    expect(result.current.isUserScroll()).toBe(false);
    act(() => result.current.handlers.onTouchMove());
    expect(result.current.isUserScroll()).toBe(true);
  });

  it("counts pointer and key input only when it targets the scroller", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUserScrollIntent());
    const container = {};
    const child = {};
    const pointer = (target: object) =>
      ({
        target,
        currentTarget: container,
      }) as unknown as PointerEvent<HTMLElement>;
    const key = (k: string, target: object) =>
      ({
        key: k,
        target,
        currentTarget: container,
      }) as unknown as KeyboardEvent<HTMLElement>;
    result.current.handlers.onPointerDown(pointer(child));
    result.current.handlers.onKeyDown(key("ArrowDown", child));
    expect(result.current.isUserScroll()).toBe(false);
    result.current.handlers.onPointerDown(pointer(container));
    expect(result.current.isUserScroll()).toBe(true);
    vi.advanceTimersByTime(USER_SCROLL_INTENT_MS + 1);
    result.current.handlers.onKeyDown(key("PageUp", child));
    expect(result.current.isUserScroll()).toBe(true);
  });
});
