import { describe, expect, it } from "vitest";
import { clamp } from "./math";

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
