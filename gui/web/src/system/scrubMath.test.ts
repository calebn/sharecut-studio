import { describe, expect, it } from "vitest";
import {
  clamp,
  fillRatio,
  formatScrub,
  inBounds,
  modifierScale,
  parseScrub,
  placesOf,
  rangeHint,
  roundTo,
  steppedValue,
} from "./scrubMath";

const none = { shiftKey: false, altKey: false };

describe("scrubMath", () => {
  it("scales a step by Shift and Alt", () => {
    expect(modifierScale(none)).toBe(1);
    expect(modifierScale({ shiftKey: true, altKey: false })).toBe(10);
    expect(modifierScale({ shiftKey: false, altKey: true })).toBe(0.1);
    expect(modifierScale({ shiftKey: true, altKey: true })).toBe(1);
  });

  it("clamps to open or closed bounds", () => {
    expect(clamp(7, { min: 0, max: 5 })).toBe(5);
    expect(clamp(-7, { min: 0 })).toBe(0);
    expect(clamp(-7, {})).toBe(-7);
  });

  it("rounds without leaving a negative zero", () => {
    expect(roundTo(0.1 + 0.2, 1)).toBe(0.3);
    expect(Object.is(roundTo(-0.04, 1), 0)).toBe(true);
  });

  it("reads the places of a step", () => {
    expect(placesOf(1)).toBe(0);
    expect(placesOf(0.5)).toBe(1);
    expect(placesOf(0.25)).toBe(2);
    expect(placesOf(1e-7)).toBe(7);
    expect(placesOf(1.5e-7)).toBe(8);
    expect(placesOf(1e21)).toBe(0);
  });

  it("writes a true minus sign", () => {
    expect(formatScrub(-3, 1)).toBe("−3.0");
    expect(formatScrub(12.345, 2)).toBe("12.35");
  });

  it("parses m:ss.mmm for seconds only", () => {
    expect(parseScrub("1:23.5", "s")).toBe(83.5);
    expect(parseScrub("0:02.380 s", "s")).toBeCloseTo(2.38, 9);
    expect(parseScrub("1:75", "s")).toBeNull();
    expect(parseScrub("1:23", "dB")).toBeNull();
  });

  it("parses typed text with a unit, a minus sign or a comma", () => {
    expect(parseScrub("120 ms", "ms")).toBe(120);
    expect(parseScrub("−3,5", "dB")).toBe(-3.5);
    expect(parseScrub(".5")).toBe(0.5);
    expect(parseScrub("")).toBeNull();
    expect(parseScrub("12abc")).toBeNull();
    expect(parseScrub("1e3")).toBeNull();
  });

  it("does not read a thousands comma as a decimal point", () => {
    expect(parseScrub("1,500", "ms")).toBeNull();
    expect(parseScrub("1,500 ms", "ms")).toBeNull();
    expect(parseScrub("1,5")).toBe(1.5);
    expect(parseScrub("1,5.2")).toBeNull();
  });

  it("rejects a number too large to hold", () => {
    expect(parseScrub("1".repeat(400))).toBeNull();
    expect(roundTo(1e308, 1)).toBe(1e308);
  });

  it("tells whether a value is inside the bounds", () => {
    expect(inBounds(500, { min: 0, max: 500 })).toBe(true);
    expect(inBounds(501, { min: 0, max: 500 })).toBe(false);
  });

  it("maps a value to a fill ratio", () => {
    expect(fillRatio(-30, { min: -60, max: 0 })).toBe(0.5);
    expect(fillRatio(10, { min: 0, max: 5 })).toBe(1);
    expect(fillRatio(1, { min: 3, max: 3 })).toBe(0);
  });

  it("steps by the modified amount and stays in bounds", () => {
    const bounds = { min: 0, max: 500 };
    expect(steppedValue(10, 1, 1, none, 0, bounds)).toBe(11);
    expect(steppedValue(10, 1, 1, { ...none, shiftKey: true }, 0, bounds)).toBe(
      20,
    );
    expect(steppedValue(10, -1, 1, { ...none, altKey: true }, 1, bounds)).toBe(
      9.9,
    );
    expect(
      steppedValue(495, 1, 1, { ...none, shiftKey: true }, 0, bounds),
    ).toBe(500);
  });

  it("names the allowed range in the hint", () => {
    expect(rangeHint({ min: 0, max: 500 }, "ms")).toBe(
      "Enter a number from 0 to 500 ms",
    );
    expect(rangeHint({ min: 0 })).toBe("Enter a number of at least 0");
    expect(rangeHint({ max: 6 }, "dB")).toBe("Enter a number of at most 6 dB");
    expect(rangeHint({})).toBe("Enter a number");
  });
});
