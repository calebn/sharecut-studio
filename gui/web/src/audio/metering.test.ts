import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIP_DB,
  decayPeakHold,
  PEAK_HOLD_FALL_DB_PER_SEC,
  peakDbFromSamples,
  peakLinear,
  SILENT_METER,
  stepMeter,
} from "./metering";

describe("peakLinear", () => {
  it("returns the largest magnitude and 0 for silence", () => {
    expect(peakLinear(new Float32Array(8))).toBe(0);
    expect(peakLinear(new Float32Array([0.1, -0.4, 0.2]))).toBeCloseTo(0.4, 6);
  });
});

describe("peakDbFromSamples", () => {
  it("reports digital silence as -Infinity", () => {
    expect(peakDbFromSamples(new Float32Array(128))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it("reports a full-scale sample as 0 dBFS", () => {
    const frame = new Float32Array([0.1, -0.4, 1.0, 0.2]);
    expect(peakDbFromSamples(frame)).toBeCloseTo(0, 10);
  });

  it("uses magnitude, so negative peaks count", () => {
    expect(peakDbFromSamples(new Float32Array([-1.0]))).toBeCloseTo(0, 10);
  });

  it("halving amplitude drops 6.02 dB", () => {
    expect(peakDbFromSamples(new Float32Array([0.5]))).toBeCloseTo(-6.0206, 3);
  });
});

describe("decayPeakHold", () => {
  it("jumps instantly to a new higher peak", () => {
    expect(decayPeakHold(-20, -6, 16)).toBe(-6);
  });

  it("falls at PPM ballistics: 20 dB over 1.5 s", () => {
    expect(PEAK_HOLD_FALL_DB_PER_SEC).toBeCloseTo(20 / 1.5, 10);
    expect(decayPeakHold(-6, -60, 750)).toBeCloseTo(
      -6 - PEAK_HOLD_FALL_DB_PER_SEC * 0.75,
      10,
    );
  });

  it("never falls below the current level", () => {
    expect(decayPeakHold(-6, -7, 10_000)).toBe(-7);
  });

  it("decays from a held peak even through silence", () => {
    const held = decayPeakHold(-6, Number.NEGATIVE_INFINITY, 1000, {
      fallDbPerSec: PEAK_HOLD_FALL_DB_PER_SEC,
    });
    expect(held).toBeCloseTo(-6 - PEAK_HOLD_FALL_DB_PER_SEC, 10);
  });

  it("drops to -Infinity once it falls past the floor", () => {
    expect(decayPeakHold(-55, Number.NEGATIVE_INFINITY, 1000)).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(decayPeakHold(-20, -80, 10_000, { floorDb: -48 })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it("does not hold a new peak that is below the floor", () => {
    expect(
      decayPeakHold(Number.NEGATIVE_INFINITY, -72, 16, { floorDb: -60 }),
    ).toBe(Number.NEGATIVE_INFINITY);
  });

  it("treats a negative dt as zero so the hold never rises", () => {
    expect(decayPeakHold(-10, -30, -500)).toBe(-10);
  });
});

describe("stepMeter", () => {
  it("reads the frame peak, jumps the hold and latches clip at the default", () => {
    const next = stepMeter(SILENT_METER, new Float32Array([0.95]), 16);
    expect(next.levelDb).toBeCloseTo(-0.446, 2);
    expect(next.peakHoldDb).toBeCloseTo(-0.446, 2);
    expect(next.clipped).toBe(true);
  });

  it("keeps the clip latched through quiet frames", () => {
    const hot = stepMeter(SILENT_METER, new Float32Array([1]), 16);
    const quiet = stepMeter(hot, new Float32Array([0.01]), 16);
    expect(quiet.clipped).toBe(true);
    expect(quiet.levelDb).toBeCloseTo(-40, 5);
  });

  it("honors a custom clip threshold", () => {
    const frame = new Float32Array([0.5]); // ≈ -6 dBFS
    expect(stepMeter(SILENT_METER, frame, 16).clipped).toBe(false);
    expect(stepMeter(SILENT_METER, frame, 16, { clipDb: -10 }).clipped).toBe(
      true,
    );
    expect(DEFAULT_CLIP_DB).toBe(-1);
  });

  it("decays the hold across several frames", () => {
    let s = stepMeter(SILENT_METER, new Float32Array([0.5]), 0);
    for (let i = 0; i < 3; i++) {
      s = stepMeter(s, new Float32Array(8), 500);
    }
    expect(s.peakHoldDb).toBeCloseTo(
      -6.0206 - PEAK_HOLD_FALL_DB_PER_SEC * 1.5,
      3,
    );
  });
});
