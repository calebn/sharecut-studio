import { describe, expect, it } from "vitest";
import {
  dbToFraction,
  decayPeakHold,
  formatDb,
  PEAK_HOLD_FALL_DB_PER_SEC,
  peakDbFromSamples,
  zoneForDb,
} from "./metering";

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

describe("dbToFraction", () => {
  it("maps 0 dBFS to 1 and the floor to 0", () => {
    expect(dbToFraction(0, -60)).toBe(1);
    expect(dbToFraction(-60, -60)).toBe(0);
  });

  it("is dB-linear: -30 dBFS is halfway on a -60 scale", () => {
    expect(dbToFraction(-30, -60)).toBe(0.5);
  });

  it("clamps out-of-range inputs instead of overfilling", () => {
    expect(dbToFraction(3, -60)).toBe(1);
    expect(dbToFraction(-90, -60)).toBe(0);
    expect(dbToFraction(Number.NEGATIVE_INFINITY, -60)).toBe(0);
  });
});

describe("zoneForDb", () => {
  it("classifies ok / warn / danger at the exact boundaries", () => {
    expect(zoneForDb(-13)).toBe("ok");
    expect(zoneForDb(-12)).toBe("warn");
    expect(zoneForDb(-7)).toBe("warn");
    expect(zoneForDb(-6)).toBe("danger");
    expect(zoneForDb(-3)).toBe("danger");
  });

  it("honors custom thresholds", () => {
    expect(zoneForDb(-18, -20, -10)).toBe("warn");
    expect(zoneForDb(-9, -20, -10)).toBe("danger");
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
    expect(decayPeakHold(-7, -6.5, 10_000)).toBe(-6.5);
  });

  it("decays from a held peak even through silence", () => {
    const held = decayPeakHold(
      -6,
      Number.NEGATIVE_INFINITY,
      1000,
      PEAK_HOLD_FALL_DB_PER_SEC,
    );
    expect(held).toBeCloseTo(-6 - PEAK_HOLD_FALL_DB_PER_SEC, 10);
  });
});

describe("formatDb", () => {
  it("renders silence as -∞ dBFS", () => {
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("-∞ dBFS");
  });

  it("rounds to whole dB", () => {
    expect(formatDb(-12.4)).toBe("-12 dBFS");
  });
});
