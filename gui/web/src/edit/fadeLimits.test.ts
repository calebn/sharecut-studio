import { describe, expect, it } from "vitest";
import { clampFadeMs, maxFadeMs } from "./fadeLimits";

describe("maxFadeMs", () => {
  it("takes the smaller of the track cap and the clip length", () => {
    expect(maxFadeMs(2, 40)).toBe(40);
    expect(maxFadeMs(0.025, 40)).toBe(25);
  });
  it("is the clip length when the track is uncapped", () => {
    expect(maxFadeMs(2, null)).toBe(2000);
    expect(maxFadeMs(2)).toBe(2000);
  });
});

describe("clampFadeMs", () => {
  it("rounds and clamps into [0, max]", () => {
    expect(clampFadeMs(500.4, 40)).toBe(40);
    expect(clampFadeMs(-5, 40)).toBe(0);
    expect(clampFadeMs(12.6, 40)).toBe(13);
  });
});
