import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsedSince } from "./useElapsedSince";

describe("useElapsedSince", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is zero without a start", () => {
    const { result } = renderHook(() => useElapsedSince(null, true));
    expect(result.current).toBe(0);
  });

  it("grows once a second while active and never goes negative", () => {
    const start = performance.now();
    const { result } = renderHook(() => useElapsedSince(start, true));
    expect(result.current).toBeGreaterThanOrEqual(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBeGreaterThanOrEqual(3000);
  });

  it("holds while inactive", () => {
    const start = performance.now();
    const { result } = renderHook(() => useElapsedSince(start, false));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBeLessThan(1000);
  });
});
