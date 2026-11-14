import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeldBusy } from "./useHeldBusy";

describe("useHeldBusy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is never busy without a press, even while an attempt is active", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useHeldBusy(active, 600),
      { initialProps: { active: false } },
    );
    expect(result.current.busy).toBe(false);
    rerender({ active: true });
    expect(result.current.busy).toBe(false);
    rerender({ active: false });
    expect(result.current.busy).toBe(false);
  });

  it("is busy at the press, before the attempt is reported active", () => {
    const { result } = renderHook(() => useHeldBusy(false, 600));
    act(() => result.current.press());
    expect(result.current.busy).toBe(true);
  });

  it("holds 600 ms after an attempt that settled in 10 ms", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useHeldBusy(active, 600),
      { initialProps: { active: false } },
    );
    act(() => result.current.press());
    rerender({ active: true });
    act(() => void vi.advanceTimersByTime(10));
    rerender({ active: false });
    expect(result.current.busy).toBe(true);
    act(() => void vi.advanceTimersByTime(589));
    expect(result.current.busy).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.busy).toBe(false);
  });

  it("stays busy past the floor for as long as the attempt runs", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useHeldBusy(active, 600),
      { initialProps: { active: false } },
    );
    act(() => result.current.press());
    rerender({ active: true });
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current.busy).toBe(true);
    rerender({ active: false });
    expect(result.current.busy).toBe(false);
  });

  it("does not call a later automatic attempt busy after the press is over", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useHeldBusy(active, 600),
      { initialProps: { active: false } },
    );
    act(() => result.current.press());
    rerender({ active: true });
    rerender({ active: false });
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current.busy).toBe(false);
    rerender({ active: true });
    expect(result.current.busy).toBe(false);
  });

  it("restarts the floor on a second press", () => {
    const { result } = renderHook(() => useHeldBusy(false, 600));
    act(() => result.current.press());
    act(() => void vi.advanceTimersByTime(500));
    act(() => result.current.press());
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.busy).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.busy).toBe(false);
  });
});
