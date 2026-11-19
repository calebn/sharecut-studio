import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadingClock } from "./loadingClock";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const waited = (view: { result: { current: number } }) => view.result.current;

describe("useLoadingClock", () => {
  it("starts at 0 for a screen that mounts alone", () => {
    const first = renderHook(() => useLoadingClock());
    expect(waited(first)).toBe(0);
  });

  it("continues the start of a screen that is replaced by another in the same commit", () => {
    const first = renderHook(() => useLoadingClock());
    act(() => void vi.advanceTimersByTime(200));
    const second = renderHook(() => useLoadingClock());
    expect(waited(second)).toBe(200);
    first.unmount();
    act(() => void vi.advanceTimersByTime(100));
    const third = renderHook(() => useLoadingClock());
    expect(waited(third)).toBe(300);
  });

  it("continues within 250 ms of the last release, and starts fresh after that", () => {
    const first = renderHook(() => useLoadingClock());
    act(() => void vi.advanceTimersByTime(200));
    first.unmount();
    act(() => void vi.advanceTimersByTime(250));
    const handoff = renderHook(() => useLoadingClock());
    expect(waited(handoff)).toBe(450);
    handoff.unmount();
    act(() => void vi.advanceTimersByTime(600));
    const later = renderHook(() => useLoadingClock());
    expect(waited(later)).toBe(0);
  });

  it("counts no negative time when the clock is set back while a screen is held", () => {
    const first = renderHook(() => useLoadingClock());
    act(() => void vi.advanceTimersByTime(200));
    vi.setSystemTime(Date.now() - 3_600_000);
    const second = renderHook(() => useLoadingClock());
    expect(waited(second)).toBe(0);
    first.unmount();
    second.unmount();
    const later = renderHook(() => useLoadingClock());
    expect(waited(later)).toBe(0);
  });

  it("holds one start through the double mount of StrictMode", () => {
    let seen = -1;
    function Probe() {
      seen = useLoadingClock();
      return null;
    }
    const first = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(seen).toBe(0);
    act(() => void vi.advanceTimersByTime(200));
    const second = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(seen).toBe(200);
    first.unmount();
    second.unmount();
  });
});
