import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_GONE_WAIT_MS, useHostGoneWait } from "./useHostGoneWait";

const useWait = (props: { gone: boolean }) => useHostGoneWait(props.gone);

describe("useHostGoneWait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits a minute after the host is seen gone", () => {
    const { result } = renderHook(useWait, { initialProps: { gone: true } });
    expect(HOST_GONE_WAIT_MS).toBe(60_000);
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("stays false while the host is there", () => {
    const { result } = renderHook(useWait, { initialProps: { gone: false } });
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(result.current).toBe(false);
  });

  it("starts again from zero when the host comes back at 30 s and drops again", () => {
    const { result, rerender } = renderHook(useWait, {
      initialProps: { gone: true },
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ gone: false });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ gone: true });
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("closes again the moment the host returns", () => {
    const { result, rerender } = renderHook(useWait, {
      initialProps: { gone: true },
    });
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current).toBe(true);
    rerender({ gone: false });
    expect(result.current).toBe(false);
  });

  it("is not moved by the wall clock", () => {
    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    const { result } = renderHook(useWait, { initialProps: { gone: true } });
    vi.setSystemTime(new Date("2090-01-01T00:00:00Z"));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(false);
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(true);
  });

  it("clears the timer on unmount", () => {
    const { unmount } = renderHook(useWait, { initialProps: { gone: true } });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
