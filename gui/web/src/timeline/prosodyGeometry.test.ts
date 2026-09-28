import { describe, expect, it } from "vitest";
import { energyTopPct, inPxRange, prosodyStatusLabel } from "./prosodyGeometry";

describe("energyTopPct", () => {
  const range = { min: 50, max: 70 };

  it("puts the max at the top of the band", () => {
    expect(energyTopPct(70, range)).toBe(15);
  });

  it("puts the min at the bottom of the band", () => {
    expect(energyTopPct(50, range)).toBe(85);
  });

  it("centers a flat range", () => {
    expect(energyTopPct(60, { min: 60, max: 60 })).toBe(50);
  });

  it("centers a null range", () => {
    expect(energyTopPct(60, null)).toBe(50);
  });

  it("clamps out-of-range values", () => {
    expect(energyTopPct(200, range)).toBe(15);
    expect(energyTopPct(-200, range)).toBe(85);
  });
});

describe("inPxRange", () => {
  it("is true when the interval overlaps the visible range", () => {
    expect(inPxRange(1, 3, 100, 0, 500)).toBe(true);
  });

  it("is true at the exact edges", () => {
    expect(inPxRange(5, 6, 100, 500, 1000)).toBe(true);
    expect(inPxRange(10, 11, 100, 0, 1000)).toBe(true);
  });

  it("is false when fully outside the range", () => {
    expect(inPxRange(20, 21, 100, 0, 500)).toBe(false);
    expect(inPxRange(-5, -1, 100, 0, 500)).toBe(false);
  });
});

describe("prosodyStatusLabel", () => {
  it("labels non-fresh statuses", () => {
    expect(prosodyStatusLabel("stale")).toMatch(/out of date/i);
    expect(prosodyStatusLabel("missing")).toMatch(/no prosody profile/i);
    expect(prosodyStatusLabel("unavailable")).toMatch(/unavailable/i);
  });

  it("has no label for fresh", () => {
    expect(prosodyStatusLabel("fresh")).toBeNull();
  });
});
