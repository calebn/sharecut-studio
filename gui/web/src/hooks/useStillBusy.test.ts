import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStillBusy } from "./useStillBusy";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("turns true only after the delay, and false the moment the work ends", () => {
  const { result, rerender } = renderHook(
    ({ active }) => useStillBusy(active, 400),
    { initialProps: { active: true } },
  );
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(399));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toBe(true);
  rerender({ active: false });
  expect(result.current).toBe(false);
});

it("never shows for work that ends before the delay, and starts over for the next", () => {
  const { result, rerender } = renderHook(
    ({ active }) => useStillBusy(active, 400),
    { initialProps: { active: true } },
  );
  act(() => vi.advanceTimersByTime(300));
  rerender({ active: false });
  act(() => vi.advanceTimersByTime(500));
  expect(result.current).toBe(false);
  rerender({ active: true });
  act(() => vi.advanceTimersByTime(300));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(100));
  expect(result.current).toBe(true);
});
