import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWriteBack } from "./useWriteBack";

describe("useWriteBack", () => {
  it("stays quiet for the first value and reports each change after it", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useWriteBack(value, onChange),
      { initialProps: { value: [1] } },
    );
    expect(onChange).not.toHaveBeenCalled();
    rerender({ value: [2] });
    rerender({ value: [3] });
    expect(onChange.mock.calls).toEqual([[[2]], [[3]]]);
  });

  it("stays quiet on mount when effects run twice", () => {
    const onChange = vi.fn();
    const value = [1];
    renderHook(() => useWriteBack(value, onChange), { wrapper: StrictMode });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report a re-render with the same value", () => {
    const onChange = vi.fn();
    const value = [1];
    const { rerender } = renderHook(() => useWriteBack(value, onChange));
    rerender();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports to the latest handler, and to none without one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ value, onChange }) => useWriteBack(value, onChange),
      {
        initialProps: {
          value: 1,
          onChange: first as ((v: number) => void) | undefined,
        },
      },
    );
    rerender({ value: 2, onChange: second });
    rerender({ value: 3, onChange: undefined });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(2);
  });
  it("reports a change that returns to the first value", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useWriteBack(value, onChange),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    rerender({ value: "a" });
    expect(onChange.mock.calls).toEqual([["b"], ["a"]]);
  });

  it("flushes the live value on unmount only when it differs from the last report", async () => {
    const quiet = vi.fn();
    const unchanged = renderHook(() => useWriteBack(1, quiet));
    unchanged.unmount();
    await Promise.resolve();
    expect(quiet).not.toHaveBeenCalled();

    const loud = vi.fn();
    const pending = renderHook(({ latest }) => useWriteBack(1, loud, latest), {
      initialProps: { latest: 1 },
    });
    pending.rerender({ latest: 5 });
    pending.unmount();
    await Promise.resolve();
    expect(loud).toHaveBeenCalledExactlyOnceWith(5);
  });
});
