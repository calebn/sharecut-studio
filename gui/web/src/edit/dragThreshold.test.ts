import { describe, expect, it } from "vitest";
import { isHandleDrag } from "./dragThreshold";

describe("isHandleDrag", () => {
  it("treats under 3 px as a click", () => {
    expect(isHandleDrag(100, 102.9)).toBe(false);
    expect(isHandleDrag(100, 100)).toBe(false);
  });
  it("treats 3 px or more as a drag in either direction", () => {
    expect(isHandleDrag(100, 103)).toBe(true);
    expect(isHandleDrag(100, 97)).toBe(true);
  });
});
