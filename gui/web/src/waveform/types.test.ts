import { describe, expect, it } from "vitest";
import {
  isReady,
  postFaderDisplayGain,
  refKind,
  resolveWaveformScale,
} from "./types";

describe("waveform types", () => {
  it("maps refs to the status kind that lists them", () => {
    expect(refKind("stem:host")).toBe("stem");
    expect(refKind("track:host")).toBe("raw");
    expect(refKind("source:abc")).toBe("raw");
  });

  it("narrows ready entries", () => {
    expect(isReady({ status: "generating" })).toBe(false);
    expect(isReady(null)).toBe(false);
    expect(
      isReady({
        status: "ready",
        key: "0".repeat(20),
        sample_rate: 48000,
        channels: 1,
        total_frames: 0,
        base_spp: 64,
        level_factor: 4,
        bins_per_tile: 4096,
        levels: [{ spp: 64, bins: 0 }],
      }),
    ).toBe(true);
  });
});

describe("resolveWaveformScale", () => {
  it("draws dialogue in dB under auto", () => {
    expect(resolveWaveformScale("auto", "dialogue")).toBe("log");
  });

  it("draws every other role linear under auto", () => {
    expect(resolveWaveformScale("auto", "music")).toBe("linear");
    expect(resolveWaveformScale("auto", "sfx")).toBe("linear");
    expect(resolveWaveformScale("auto", "")).toBe("linear");
  });

  it("forces one scale on every lane when not auto", () => {
    expect(resolveWaveformScale("linear", "dialogue")).toBe("linear");
    expect(resolveWaveformScale("log", "music")).toBe("log");
  });
});

describe("postFaderDisplayGain", () => {
  it("rounds the output gain to 0.5 dB before converting", () => {
    expect(postFaderDisplayGain(-6)).toBeCloseTo(10 ** (-6 / 20), 9);
    expect(postFaderDisplayGain(-6.2)).toBe(postFaderDisplayGain(-6));
    expect(postFaderDisplayGain(-6.3)).toBe(postFaderDisplayGain(-6.5));
    expect(postFaderDisplayGain(0)).toBe(1);
  });
});
