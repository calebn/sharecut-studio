import { describe, expect, it } from "vitest";
import { PAINT_DPR_CAP } from "./timelineZoom.generated";
import {
  clampWaveformAmp,
  formatWaveformAmp,
  MAX_WAVEFORM_AMP,
  MAX_ZOOM_PX_PER_SEC,
  MIN_WAVEFORM_AMP,
  MIN_ZOOM_PX_PER_SEC,
} from "./zoom";

describe("waveform amplitude zoom", () => {
  it("clamps to 1–16", () => {
    expect(clampWaveformAmp(0)).toBe(MIN_WAVEFORM_AMP);
    expect(clampWaveformAmp(99)).toBe(MAX_WAVEFORM_AMP);
  });
});

describe("formatWaveformAmp", () => {
  it("formats integers without decimals", () => {
    expect(formatWaveformAmp(1)).toBe("1");
    expect(formatWaveformAmp(2)).toBe("2");
  });

  it("formats fractional amounts to two decimals", () => {
    expect(formatWaveformAmp(1.25)).toBe("1.25");
    expect(formatWaveformAmp(1.5625)).toBe("1.56");
  });
});

describe("generated zoom contract", () => {
  it("re-exports the contract zoom bounds and waveform paint cap", () => {
    expect(MIN_ZOOM_PX_PER_SEC).toBe(0.05);
    expect(MAX_ZOOM_PX_PER_SEC).toBeGreaterThan(MIN_ZOOM_PX_PER_SEC);
    expect(PAINT_DPR_CAP).toBe(2);
  });
});
