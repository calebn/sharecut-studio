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
  it("waits for the first full tick when enabled with an unchanged inactive origin", () => {
    const start = performance.now();
    const { result, rerender } = renderHook(
      ({ active }) => useElapsedSince(start, active),
      { initialProps: { active: false } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const frozen = result.current;
    rerender({ active: true });
    expect(result.current).toBe(frozen);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe(frozen);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeCloseTo(6000, 5);
  });

  it("resamples a changed origin while inactive", () => {
    const { result, rerender } = renderHook(
      ({ start }) => useElapsedSince(start, false),
      { initialProps: { start: performance.now() } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender({ start: performance.now() - 1000 });
    expect(result.current).toBeCloseTo(1000, 5);
  });

  it("keeps the existing active deadline when the origin changes", () => {
    const { result, rerender } = renderHook(
      ({ start }) => useElapsedSince(start, true),
      { initialProps: { start: performance.now() } },
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ start: 200 });
    expect(result.current).toBeCloseTo(300, 5);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBeCloseTo(300, 5);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeCloseTo(800, 5);
  });

  it("keeps the active interval for a null origin and clamps a future origin", () => {
    const scheduled = vi.spyOn(window, "setInterval");
    const { result, rerender, unmount } = renderHook(
      ({ start }: { start: number | null }) => useElapsedSince(start, true),
      { initialProps: { start: null as number | null } },
    );
    expect(result.current).toBe(0);
    expect(scheduled).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(0);
    rerender({ start: performance.now() + 1000 });
    expect(result.current).toBe(0);
    expect(scheduled).toHaveBeenCalledOnce();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    scheduled.mockRestore();
  });
});
