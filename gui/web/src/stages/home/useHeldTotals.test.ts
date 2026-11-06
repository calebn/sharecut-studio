import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DownloadTotals } from "./homeModel";
import { useHeldTotals } from "./useHeldTotals";

describe("useHeldTotals", () => {
  it("holds the bytes at a component boundary and after the last one", () => {
    const total = 100;
    const { result, rerender } = renderHook(
      ({ totals }: { totals: DownloadTotals | null }) => useHeldTotals(totals),
      {
        initialProps: { totals: { bytes: 60, total } as DownloadTotals | null },
      },
    );
    rerender({ totals: { bytes: 0, total } });
    expect(result.current).toEqual({ bytes: 60, total });
    rerender({ totals: { bytes: 100, total } });
    rerender({ totals: { bytes: 0, total } });
    expect(result.current).toEqual({ bytes: 100, total });
    rerender({ totals: null });
    expect(result.current).toBeNull();
    rerender({ totals: { bytes: 5, total } });
    expect(result.current).toEqual({ bytes: 5, total });
  });
});
