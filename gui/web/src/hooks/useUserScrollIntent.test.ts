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

  it("does not count a touch tap, but counts a touch drag", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUserScrollIntent());
    act(() => {
      result.current.handlers.onTouchStart();
      result.current.handlers.onTouchEnd();
    });
    expect(result.current.isUserScroll()).toBe(false);
    act(() => {
      result.current.handlers.onTouchStart();
      result.current.handlers.onTouchMove();
      result.current.handlers.onTouchEnd();
    });
    expect(result.current.isUserScroll()).toBe(true);
  });

  it.each(["wheel", "key", "scrollbar"] as const)(
    "preserves %s input arriving after a stationary touch starts",
    (input) => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useUserScrollIntent());
      const container = {};
      act(() => {
        result.current.handlers.onTouchStart();
        if (input === "wheel") result.current.handlers.onWheel();
        else if (input === "key") {
          result.current.handlers.onKeyDown({
            key: "PageDown",
            target: container,
            currentTarget: container,
          } as unknown as KeyboardEvent<HTMLElement>);
        } else {
          result.current.handlers.onPointerDown({
            target: container,
            currentTarget: container,
          } as unknown as PointerEvent<HTMLElement>);
        }
        result.current.handlers.onTouchEnd();
      });
      expect(result.current.isUserScroll()).toBe(true);
      vi.advanceTimersByTime(USER_SCROLL_INTENT_MS + 1);
      expect(result.current.isUserScroll()).toBe(false);
    },
  );

  it("still cancels wheel input from before a stationary touch starts", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUserScrollIntent());
    act(() => result.current.handlers.onWheel());
    expect(result.current.isUserScroll()).toBe(true);
    act(() => {
      result.current.handlers.onTouchStart();
      result.current.handlers.onTouchEnd();
    });
    expect(result.current.isUserScroll()).toBe(false);
  });

  it.each(["pointer", "key"] as const)(
    "does not retain a tap for ineligible child %s input",
    (input) => {
      const { result } = renderHook(() => useUserScrollIntent());
      const container = {};
      const child = {};
      act(() => {
        result.current.handlers.onTouchStart();
        if (input === "pointer") {
          result.current.handlers.onPointerDown({
            target: child,
            currentTarget: container,
          } as unknown as PointerEvent<HTMLElement>);
        } else {
          result.current.handlers.onKeyDown({
            key: "ArrowDown",
            target: child,
            currentTarget: container,
          } as unknown as KeyboardEvent<HTMLElement>);
        }
        result.current.handlers.onTouchEnd();
      });
      expect(result.current.isUserScroll()).toBe(false);
      act(() => result.current.handlers.onWheel());
      expect(result.current.isUserScroll()).toBe(true);
    },
  );

  it("does not extend a later wheel deadline when the touch ends", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUserScrollIntent());
    act(() => result.current.handlers.onTouchStart());
    vi.advanceTimersByTime(500);
    act(() => result.current.handlers.onWheel());
    vi.advanceTimersByTime(500);
    act(() => result.current.handlers.onTouchEnd());
    expect(result.current.isUserScroll()).toBe(true);
    vi.advanceTimersByTime(101);
    expect(result.current.isUserScroll()).toBe(false);
  });

  it("keeps handler identities stable across input and rerender", () => {
    const { result, rerender } = renderHook(() => useUserScrollIntent());
    const initial = result.current;
    act(() => {
      result.current.handlers.onTouchStart();
      result.current.handlers.onWheel();
      result.current.handlers.onTouchEnd();
    });
    rerender();
    expect(result.current.isUserScroll()).toBe(true);
    expect(result.current.handlers).toBe(initial.handlers);
    expect(result.current.isUserScroll).toBe(initial.isUserScroll);
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
