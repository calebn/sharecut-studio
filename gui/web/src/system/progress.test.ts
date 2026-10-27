import { describe, expect, it } from "vitest";
import { clampUnit, percentOf } from "./progress";

describe("clampUnit", () => {
  it.each([
    [-0.2, 0],
    [0, 0],
    [0.4, 0.4],
    [1, 1],
    [1.4, 1],
    [Number.NaN, 0],
    [undefined, 0],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 0],
  ])("holds %s to %s", (input, expected) => {
    expect(clampUnit(input)).toBe(expected);
  });

  it("rounds to a whole percent", () => {
    expect(percentOf(0.404)).toBe(40);
    expect(percentOf(1.4)).toBe(100);
    expect(percentOf(-1)).toBe(0);
    expect(percentOf(Number.NaN)).toBe(0);
  });
});
