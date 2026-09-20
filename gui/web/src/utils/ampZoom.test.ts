import { describe, expect, it } from "vitest";
import { FINEST_BINS_PER_SEC } from "./timelineZoom.generated";
import {
  clampWaveformAmp,
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

describe("generated zoom contract", () => {
  it("does not hardcode a 400 Hz peak ceiling", () => {
    expect(FINEST_BINS_PER_SEC).toBe(MAX_ZOOM_PX_PER_SEC * 2);
    expect(MIN_ZOOM_PX_PER_SEC).toBe(0.05);
  });
});
