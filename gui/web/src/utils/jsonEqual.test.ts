import { describe, expect, it } from "vitest";
import { jsonEqual } from "./jsonEqual";

describe("jsonEqual", () => {
  it("is true for the same reference and for equal JSON values", () => {
    const a = { x: [1, 2], y: "z" };
    expect(jsonEqual(a, a)).toBe(true);
    expect(jsonEqual(a, { x: [1, 2], y: "z" })).toBe(true);
  });

  it("is false for a changed value", () => {
    expect(jsonEqual({ x: [1, 2] }, { x: [1, 3] })).toBe(false);
  });

  it("is key-order sensitive (a missed match, never a false one)", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });
});
