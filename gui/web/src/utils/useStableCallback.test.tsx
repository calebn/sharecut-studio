import { render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity across renders", () => {
    const { result, rerender } = renderHook(
      ({ n }) => useStableCallback(() => n),
      { initialProps: { n: 1 } },
    );
    const first = result.current;
    rerender({ n: 2 });
    expect(result.current).toBe(first);
  });

  it("calls the latest function with its arguments", () => {
    const a = vi.fn((x: number) => x + 1);
    const b = vi.fn((x: number) => x + 2);
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
      initialProps: { fn: a },
    });
    rerender({ fn: b });
    expect(result.current(1)).toBe(3);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(1);
  });

  it("is current in a child's layout effect of the same commit", () => {
    const seen: string[] = [];
    function Child({ onMount }: { onMount: () => void }) {
      useLayoutEffect(() => {
        onMount();
      });
      return null;
    }
    function Parent({ label }: { label: string }) {
      const cb = useStableCallback(() => seen.push(label));
      return <Child onMount={cb} />;
    }
    const { rerender } = render(<Parent label="a" />);
    rerender(<Parent label="b" />);
    expect(seen).toEqual(["a", "b"]);
  });
});
