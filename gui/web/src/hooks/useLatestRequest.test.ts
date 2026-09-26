import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRequest } from "./useLatestRequest";

describe("useLatestRequest", () => {
  it("treats only the latest begun request as current", () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current.begin();
    const second = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it("retires the pending request on invalidate", () => {
    const { result } = renderHook(() => useLatestRequest());
    const token = result.current.begin();
    result.current.invalidate();
    expect(result.current.isCurrent(token)).toBe(false);
  });

  it("retires the pending request on unmount", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    const latest = result.current;
    const token = latest.begin();
    unmount();
    expect(latest.isCurrent(token)).toBe(false);
  });

  it("returns the same object across renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
