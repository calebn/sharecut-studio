import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordSessions } from "../api";
import { useRecordSessions } from "./useRecordSessions";

vi.mock("../api", () => ({ loadHostRecordSessions: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadHostRecordSessions).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useRecordSessions", () => {
  it("fetches at once the first time and debounces later keys", async () => {
    const { rerender } = renderHook(
      ({ key }) => useRecordSessions("/p", key, true),
      { initialProps: { key: "h:1" } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(loadHostRecordSessions).toHaveBeenCalledTimes(1);
    rerender({ key: "h:2" });
    rerender({ key: "h:3" });
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(loadHostRecordSessions).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2));
    expect(loadHostRecordSessions).toHaveBeenCalledTimes(2);
  });

  it("refetches within two seconds of a change that never goes quiet", async () => {
    const { rerender } = renderHook(
      ({ key }) => useRecordSessions("/p", key, true),
      { initialProps: { key: "h:0" } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    for (let i = 1; i <= 9; i++) {
      rerender({ key: `h:${i}` });
      await act(async () => vi.advanceTimersByTimeAsync(250));
    }
    expect(vi.mocked(loadHostRecordSessions).mock.calls.length).toBeGreaterThan(
      1,
    );
  });
});
