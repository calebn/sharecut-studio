import { describe, expect, it } from "vitest";
import { nextPlayheadAfterSkip } from "./skipWindow";

describe("nextPlayheadAfterSkip", () => {
  it("returns t when skip is unset", () => {
    expect(nextPlayheadAfterSkip(5, null, null)).toBe(5);
  });

  it("jumps when playhead enters the skip window", () => {
    expect(nextPlayheadAfterSkip(10, 10, 12)).toBe(12);
    expect(nextPlayheadAfterSkip(11, 10, 12)).toBe(12);
  });

  it("does not jump before or after the window", () => {
    expect(nextPlayheadAfterSkip(9.9, 10, 12)).toBe(9.9);
    expect(nextPlayheadAfterSkip(12, 10, 12)).toBe(12);
    expect(nextPlayheadAfterSkip(13, 10, 12)).toBe(13);
  });

  it("ignores inverted skip ranges", () => {
    expect(nextPlayheadAfterSkip(5, 8, 4)).toBe(5);
  });
});
