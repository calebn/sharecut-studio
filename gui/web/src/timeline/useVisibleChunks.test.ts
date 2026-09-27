import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { useVisibleChunks } from "./useVisibleChunks";

describe("useVisibleChunks", () => {
  beforeEach(() => {
    useDawStore.setState({ scrollLeft: 0, timelineViewportWidth: 0 });
  });

  it("keeps the tuple's identity within a chunk", () => {
    useDawStore.setState({ scrollLeft: 500, timelineViewportWidth: 100 });
    const { result, rerender } = renderHook(() => useVisibleChunks(100000));
    expect(result.current).toEqual([0, 0]);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    useDawStore.setState({ scrollLeft: 3000 });
    rerender();
    expect(result.current).toEqual([1, 1]);
  });

  it("clamps a short lane to its last chunk", () => {
    useDawStore.setState({ scrollLeft: 10000, timelineViewportWidth: 100 });
    const { result } = renderHook(() => useVisibleChunks(3000));
    expect(result.current).toEqual([1, 1]);
  });
});
