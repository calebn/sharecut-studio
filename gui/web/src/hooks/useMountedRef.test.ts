import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { useMountedRef } from "./useMountedRef";

describe("useMountedRef", () => {
  it("is true while mounted and false after unmount", () => {
    const { result, unmount } = renderHook(() => useMountedRef());
    const ref = result.current;
    expect(ref.current).toBe(true);
    unmount();
    expect(ref.current).toBe(false);
  });

  it("restores true after StrictMode effect replay and clears it on final unmount", () => {
    const { result, unmount } = renderHook(() => useMountedRef(), {
      wrapper: StrictMode,
    });
    const ref = result.current;
    expect(ref.current).toBe(true);
    unmount();
    expect(ref.current).toBe(false);
  });

  it("returns the same ref across renders", () => {
    const { result, rerender } = renderHook(() => useMountedRef());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
