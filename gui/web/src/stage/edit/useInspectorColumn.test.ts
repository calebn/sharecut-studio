import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "../../test/matchMedia";
import { useInspectorColumn } from "./useInspectorColumn";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInspectorColumn", () => {
  it("asks for a short, wide screen whose primary pointer is coarse", () => {
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return {
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    });
    renderHook(() => useInspectorColumn());
    expect(queries[0]).toBe(
      "(max-height: 40rem) and (pointer: coarse) and (min-width: 40rem)",
    );
  });

  it("follows the query as the phone rotates", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useInspectorColumn());
    expect(result.current).toBe(false);
    act(() => media.setMatches(true));
    expect(result.current).toBe(true);
  });

  it("is off where the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useInspectorColumn());
    expect(result.current).toBe(false);
  });
});
