import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatEffectParams } from "./effectParams";

type PresetSpec = { effect: string; params: Record<string, unknown> }[];
const BUILTIN_PRESETS = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "builtinEffectPresets.fixture.json",
    ),
    "utf8",
  ),
) as Record<string, PresetSpec>;

/** Expected Track inspector text for each builtin preset (tests/test_effects_presets.py keeps the fixture in sync). */
const EXPECTED: Record<string, string[]> = {
  noise_reduction: ["noise reduction 12 dB · noise floor -25 dB"],
  noise_reduction_heavy: ["noise reduction 20 dB · noise floor -25 dB"],
  noise_reduction_rnnoise: [""],
  deess: ["intensity 0.5 · frequency (0–1) 0.5"],
  gate: ["threshold -30 dB · range -20 dB · attack 5 ms · release 50 ms"],
  eq_presence: ["frequency 4000 Hz · width type q · width 1.5 · gain 3 dB"],
  eq_clarity: [
    "frequency 80 Hz",
    "frequency 250 Hz · width type q · width 1 · gain -2 dB",
  ],
  eq_warm: ["frequency 200 Hz · width type q · width 1 · gain 2 dB"],
  podcast_standard: [
    "frequency 80 Hz",
    "threshold -18 dB · ratio 3 · attack 15 ms · release 150 ms · makeup 0 dB",
    "integrated -16 LUFS · true peak -1.5 dB",
  ],
};

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

  it("shows deesser frequency as a 0–1 fraction, not Hz", () => {
    expect(
      formatEffectParams({ intensity: 0.5, frequency: 0.5 }, "deesser"),
    ).toBe("intensity 0.5 · frequency (0–1) 0.5");
  });

  it("keeps Hz for highpass frequency", () => {
    expect(formatEffectParams({ frequency: 80 }, "highpass")).toBe(
      "frequency 80 Hz",
    );
  });
});

describe("builtin FX presets", () => {
  it("has an expected rendering for every builtin preset", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      Object.keys(BUILTIN_PRESETS).sort(),
    );
  });

  it.each(Object.entries(BUILTIN_PRESETS))(
    "%s renders readable params",
    (name, specs) => {
      expect(specs.map((s) => formatEffectParams(s.params, s.effect))).toEqual(
        EXPECTED[name],
      );
    },
  );
});
