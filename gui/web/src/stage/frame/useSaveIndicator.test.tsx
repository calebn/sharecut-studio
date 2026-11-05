import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveState } from "./saveState";
import { useSaveIndicator } from "./useSaveIndicator";
import { type SaveAttention, useSaveState } from "./useSaveState";

vi.mock("./useSaveState", () => ({ useSaveState: vi.fn() }));

function observed(
  state: SaveState | null,
  attention: SaveAttention = { kind: "passive" },
) {
  vi.mocked(useSaveState).mockReturnValue({ state, attention });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Save completion indication", () => {
  it("does not announce a completion when a saved project first appears", () => {
    observed({ kind: "saved" });
    const { result } = renderHook(() => useSaveIndicator());
    expect(result.current).toEqual({ state: "saved", justSaved: false });
  });

  it("holds the completion check for exactly two seconds after saving finishes", () => {
    observed({ kind: "saving" });
    const { result, rerender } = renderHook(() => useSaveIndicator());
    observed({ kind: "saved" });
    rerender();
    expect(result.current).toEqual({ state: "saved", justSaved: true });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current).toEqual({ state: "saved", justSaved: true });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toEqual({ state: "saved", justSaved: false });
  });

  it("does not let an earlier completion timer shorten a later save indication", () => {
    observed({ kind: "saving" });
    const { result, rerender } = renderHook(() => useSaveIndicator());
    observed({ kind: "saved" });
    rerender();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    observed({ kind: "saving" });
    rerender();
    observed({ kind: "saved" });
    rerender();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual({ state: "saved", justSaved: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual({ state: "saved", justSaved: false });
  });

  it("does not restart the completion timer for unrelated attention changes", () => {
    observed({ kind: "saving" });
    const { result, rerender } = renderHook(() => useSaveIndicator());
    observed({ kind: "saved" });
    rerender();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    observed({ kind: "saved" }, { kind: "button", activate: vi.fn() });
    rerender();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toEqual({ state: "saved", justSaved: false });
  });

  it("retires completion across unread or failed state and keeps the current Retry action", () => {
    observed({ kind: "saving" });
    const { result, rerender } = renderHook(() => useSaveIndicator());
    observed({ kind: "saved" });
    rerender();
    observed(null);
    rerender();
    expect(result.current).toBeNull();
    const retry = vi.fn();
    observed(
      { kind: "failed", cause: "unreadable" },
      { kind: "button", activate: retry },
    );
    rerender();
    expect(result.current).toEqual({ state: "failed", onRetry: retry });
    observed({ kind: "saved" });
    rerender();
    expect(result.current).toEqual({ state: "saved", justSaved: false });
  });

  it("disposes the pending completion timer when the header leaves", () => {
    observed({ kind: "saving" });
    const { rerender, unmount } = renderHook(() => useSaveIndicator());
    observed({ kind: "saved" });
    rerender();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
