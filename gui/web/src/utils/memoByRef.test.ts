import { describe, expect, it, vi } from "vitest";
import { memoByRef } from "./memoByRef";

describe("memoByRef", () => {
  it("computes once per argument identity", () => {
    const compute = vi.fn((items: number[]) => items.length);
    const memo = memoByRef(compute);
    const a = [1, 2];
    expect(memo(a)).toBe(2);
    expect(memo(a)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(memo([1, 2])).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("caches an undefined result too", () => {
    const compute = vi.fn((_: object) => undefined);
    const memo = memoByRef(compute);
    const key = {};
    memo(key);
    memo(key);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
