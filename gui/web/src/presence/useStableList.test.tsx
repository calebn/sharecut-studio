import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { useStableList } from "./useStableList";

type Item = { id: string; value: number };
const key = (item: Item) => item.id;
const same = (a: Item, b: Item) => Object.is(a.value, b.value);
const run = (initial: Item[]) =>
  renderHook(({ list }) => useStableList(list, key, same), {
    initialProps: { list: initial },
    wrapper: StrictMode,
  });

describe("useStableList", () => {
  it("returns the same array and items for a list equal by value", () => {
    const first = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ];
    const { result, rerender } = run(first);
    const kept = result.current;
    rerender({
      list: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ],
    });
    expect(result.current).toBe(kept);
  });

  it("keeps unchanged items and takes the one that changed", () => {
    const { result, rerender } = run([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);
    const [a] = result.current;
    rerender({
      list: [
        { id: "a", value: 1 },
        { id: "b", value: 3 },
      ],
    });
    expect(result.current[0]).toBe(a);
    expect(result.current[1]).toEqual({ id: "b", value: 3 });
  });

  it("drops a removed item and follows a reorder", () => {
    const { result, rerender } = run([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "c", value: 3 },
    ]);
    const [a, , c] = result.current;
    rerender({
      list: [
        { id: "c", value: 3 },
        { id: "a", value: 1 },
      ],
    });
    expect(result.current).toEqual([c, a]);
    expect(result.current[0]).toBe(c);
    expect(result.current[1]).toBe(a);
  });

  it("settles when a value is NaN", () => {
    const { result, rerender } = run([{ id: "a", value: Number.NaN }]);
    const kept = result.current;
    rerender({ list: [{ id: "a", value: Number.NaN }] });
    expect(result.current).toBe(kept);
  });
});
