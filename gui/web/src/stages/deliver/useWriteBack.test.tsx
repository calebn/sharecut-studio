import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWriteBack } from "./useWriteBack";

describe("useWriteBack", () => {
  it("stays quiet for the first value and reports each accepted change after it", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useWriteBack([1], onChange));
    expect(onChange).not.toHaveBeenCalled();
    act(() => result.current[1](() => [2]));
    act(() => result.current[1](() => [3]));
    expect(onChange.mock.calls).toEqual([[[2]], [[3]]]);
  });

  it("stays quiet on mount when effects run twice", () => {
    const onChange = vi.fn();
    renderHook(() => useWriteBack([1], onChange), { wrapper: StrictMode });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report a rerender or an unchanged edit", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(() => useWriteBack([1], onChange));
    rerender();
    act(() => result.current[1]((current) => current));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports to the latest committed handler and to none without one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onChange }) => useWriteBack<number>(1, onChange),
      {
        initialProps: {
          onChange: first as ((value: number) => void) | undefined,
        },
      },
    );
    rerender({ onChange: second });
    act(() => result.current[1](() => 2));
    rerender({ onChange: undefined });
    act(() => result.current[1](() => 3));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("reports a change that returns to the first value", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useWriteBack<string>("a", onChange));
    act(() => result.current[1](() => "b"));
    act(() => result.current[1](() => "a"));
    expect(onChange.mock.calls).toEqual([["b"], ["a"]]);
  });

  it("flushes the live value on unmount only when it differs from the last report", async () => {
    const quiet = vi.fn();
    const unchanged = renderHook(() => useWriteBack<number>(1, quiet));
    unchanged.unmount();
    await Promise.resolve();
    expect(quiet).not.toHaveBeenCalled();
    const loud = vi.fn();
    const pending = renderHook(() => useWriteBack<number>(1, loud, true));
    act(() => pending.result.current[1](() => 5));
    expect(loud).not.toHaveBeenCalled();
    pending.unmount();
    await Promise.resolve();
    expect(loud).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("composes accepted edits before rerender and reports their final value once", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useWriteBack<number>(1, onChange));
    act(() => {
      result.current[1]((current) => current + 1);
      result.current[1]((current) => current * 3);
    });
    expect(result.current[0]).toBe(6);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(6);
  });

  it("flushes accepted commands when unmount happens before their render commits", async () => {
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useWriteBack<number>(1, onChange),
    );
    act(() => {
      result.current[1]((current) => current + 1);
      result.current[1]((current) => current * 3);
      unmount();
    });
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(6);
  });

  it("retains gesture changes and reports once when the gesture ends", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ paused }) => useWriteBack<number>(1, onChange, paused),
      {
        initialProps: { paused: true },
      },
    );
    act(() => result.current[1]((current) => current + 1));
    act(() => result.current[1]((current) => current + 1));
    expect(result.current[0]).toBe(3);
    expect(onChange).not.toHaveBeenCalled();
    rerender({ paused: false });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("flushes a held draft to the latest handler once", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ onChange }) => useWriteBack<number>(1, onChange, true),
      {
        initialProps: { onChange: first },
      },
    );
    act(() => result.current[1](() => 2));
    rerender({ onChange: second });
    unmount();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(2);
  });
  it("stores a function-valued draft without executing it as a React updater", () => {
    const first = vi.fn(() => 1);
    const next = vi.fn(() => 2);
    const onChange = vi.fn();
    const { result } = renderHook(() => useWriteBack(first, onChange));
    act(() => result.current[1](() => next));
    expect(result.current[0]).toBe(next);
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(next);
  });
});
