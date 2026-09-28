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
});
