import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNowSec } from "./useNowSec";

describe("useNowSec", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks while enabled and freezes when disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useNowSec(enabled),
      { initialProps: { enabled: true } },
    );
    const start = result.current;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBeGreaterThanOrEqual(start + 2);
    rerender({ enabled: false });
    const frozen = result.current;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(frozen);
  });

  it("syncs wall clock when enabled flips true", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useNowSec(enabled),
      { initialProps: { enabled: false } },
    );
    const frozen = result.current;
    act(() => {
      vi.setSystemTime(new Date("2026-09-18T12:00:05Z"));
    });
    rerender({ enabled: true });
    expect(result.current).toBeGreaterThanOrEqual(frozen + 5);
  });
});
