import { describe, expect, it } from "vitest";
import { clippingGate } from "./alertGates";

const at = (...seconds: number[]) =>
  seconds.map((s) => ({ startMs: s * 1000 }));

describe("clippingGate", () => {
  it("stays quiet with no regions and with two", () => {
    expect(clippingGate([])).toBe(false);
    expect(clippingGate(at(1, 2))).toBe(false);
  });

  it("fires on the third region inside 30 s", () => {
    expect(clippingGate(at(1, 10, 20))).toBe(true);
  });

  it("fires when the three starts span exactly 30 s", () => {
    expect(clippingGate(at(5, 20, 35))).toBe(true);
  });

  it("stays quiet when the three starts span more than 30 s", () => {
    expect(clippingGate(at(5, 20, 35.001))).toBe(false);
    expect(clippingGate(at(0, 31, 62))).toBe(false);
  });

  it("finds a qualifying run after earlier spread-out clips", () => {
    expect(clippingGate(at(0, 100, 110, 120))).toBe(true);
  });

  it("sorts unsorted regions before windowing", () => {
    expect(clippingGate(at(20, 1, 10))).toBe(true);
    expect(clippingGate(at(62, 0, 31))).toBe(false);
  });

  it("does not mutate its input", () => {
    const regions = at(20, 1, 10);
    clippingGate(regions);
    expect(regions.map((r) => r.startMs)).toEqual([20000, 1000, 10000]);
  });
});
