import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIntervalTick } from "./useIntervalTick";

describe("useIntervalTick", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every period while active and stops when inactive", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useIntervalTick(1000, active),
      { initialProps: { active: true } },
    );
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(3);
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(3);
  });

  it("schedules nothing while inactive", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    renderHook(() => useIntervalTick(1000, false));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
  it("retains its counter and starts a full deadline after period or active changes", () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(
      ({ period, active }) => useIntervalTick(period, active),
      { initialProps: { period: 1000, active: true } },
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(1);
    rerender({ period: 2000, active: true });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(2);
    rerender({ period: 2000, active: false });
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender({ period: 2000, active: true });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
