import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateSecondsLeft, useSecondsLeft } from "./useSecondsLeft";

describe("estimateSecondsLeft", () => {
  it("projects the average rate over what is left", () => {
    expect(
      estimateSecondsLeft(
        { at: 0, bytes: 0 },
        { at: 10_000, bytes: 100 },
        1000,
      ),
    ).toBe(90);
  });
  it("names nothing before a few seconds or when nothing moved", () => {
    expect(
      estimateSecondsLeft({ at: 0, bytes: 0 }, { at: 1_000, bytes: 50 }, 1000),
    ).toBeNull();
    expect(
      estimateSecondsLeft({ at: 0, bytes: 5 }, { at: 9_000, bytes: 5 }, 1000),
    ).toBeNull();
  });
});

describe("useSecondsLeft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("waits for a rate, then follows it, and starts over for a new download", () => {
    const { result, rerender } = renderHook(
      ({ bytes, total }) => useSecondsLeft(bytes, total),
      {
        initialProps: {
          bytes: 0 as number | null,
          total: 1000 as number | null,
        },
      },
    );
    expect(result.current).toBeNull();
    vi.setSystemTime(10_000);
    rerender({ bytes: 100, total: 1000 });
    expect(result.current).toBe(90);
    rerender({ bytes: null, total: null });
    expect(result.current).toBeNull();
  });

  it("drops the estimate when the bytes stop moving", () => {
    const { result, rerender } = renderHook(
      ({ bytes }) => useSecondsLeft(bytes, 1000),
      { initialProps: { bytes: 0 } },
    );
    vi.setSystemTime(10_000);
    rerender({ bytes: 100 });
    expect(result.current).toBe(90);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBeNull();
  });
});
