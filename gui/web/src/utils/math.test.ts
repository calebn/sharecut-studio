import { describe, expect, it } from "vitest";
import { clamp, lastIndexAtOrBefore } from "./math";

describe("clamp", () => {
  it("limits to the range and keeps in-range values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("lets the upper bound win on an inverted range", () => {
    expect(clamp(5, 10, 0)).toBe(0);
  });
});

describe("lastIndexAtOrBefore", () => {
  const ascending = [1, 2, 2, 4, 8];
  it.each([
    [0.5, undefined],
    [1, 0],
    [1.9, 0],
    [2, 2],
    [7.99, 3],
    [8, 4],
    [100, 4],
  ])("at %s", (target, index) => {
    expect(lastIndexAtOrBefore(ascending, target)).toBe(index);
  });

  it("finds nothing in an empty array", () => {
    expect(lastIndexAtOrBefore([], 5)).toBeUndefined();
  });
});
