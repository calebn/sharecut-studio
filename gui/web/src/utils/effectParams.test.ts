import { describe, expect, it } from "vitest";
import { formatEffectParams } from "./effectParams";

describe("formatEffectParams", () => {
  it("labels known ffmpeg keys with units", () => {
    expect(formatEffectParams({ f: 4000, t: "q", w: 1.5, g: 3 })).toBe(
      "frequency 4000 Hz · width type q · width 1.5 · gain 3 dB",
    );
  });

  it("infers a unit from a _db/_ms suffix", () => {
    expect(
      formatEffectParams({
        threshold_db: -18,
        ratio: 3,
        attack_ms: 5.1234,
      }),
    ).toBe("threshold -18 dB · ratio 3 · attack 5.12 ms");
  });

  it("returns an empty string for no params", () => {
    expect(formatEffectParams({})).toBe("");
    expect(formatEffectParams(null)).toBe("");
    expect(formatEffectParams(undefined)).toBe("");
  });

  it("falls back to JSON for a nested object", () => {
    expect(formatEffectParams({ shape: { a: 1 } })).toBe('shape {"a":1}');
  });

  it("shows a boolean as on/off", () => {
    expect(formatEffectParams({ enabled: true, muted: false })).toBe(
      "enabled on · muted off",
    );
  });
});
