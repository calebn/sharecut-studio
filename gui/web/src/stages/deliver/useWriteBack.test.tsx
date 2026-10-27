import { renderHook } from "@testing-library/react";
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
});
