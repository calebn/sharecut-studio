import { describe, expect, it } from "vitest";
import { ariaValueNow, dbToFraction, formatDb, zoneForDb } from "./metering";

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

describe("ariaValueNow", () => {
  it("rounds in-range readings", () => {
    expect(ariaValueNow(-12.4, -60)).toBe(-12);
  });

  it("clamps into [minDb, 0] for the ARIA meter contract", () => {
    expect(ariaValueNow(0.5, -60)).toBe(0);
    expect(ariaValueNow(-72, -60)).toBe(-60);
    expect(ariaValueNow(Number.NEGATIVE_INFINITY)).toBe(-60);
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

describe("formatDb", () => {
  it("renders silence as -∞ dBFS", () => {
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("-∞ dBFS");
  });

  it("rounds to whole dB", () => {
    expect(formatDb(-12.4)).toBe("-12 dBFS");
  });
});
