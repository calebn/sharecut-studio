import { describe, expect, it } from "vitest";
import {
  clampLaneHeight,
  itemBox,
  itemVisible,
  laneMuteLook,
  windowStartFor,
} from "./laneMath";

describe("clampLaneHeight", () => {
  it("holds a lane to 72 through 240 px", () => {
    expect(clampLaneHeight(60)).toBe(72);
    expect(clampLaneHeight(72)).toBe(72);
    expect(clampLaneHeight(104)).toBe(104);
    expect(clampLaneHeight(240)).toBe(240);
    expect(clampLaneHeight(300)).toBe(240);
  });

  it("takes the least for no number, and rounds so a row's top stays whole", () => {
    expect(clampLaneHeight(undefined)).toBe(72);
    expect(clampLaneHeight(Number.NaN)).toBe(72);
    expect(clampLaneHeight(Number.POSITIVE_INFINITY)).toBe(72);
    expect(clampLaneHeight(100.4)).toBe(100);
  });
});

describe("windowStartFor", () => {
  it("puts the playhead at the middle of the lane", () => {
    expect(windowStartFor(10, 24, 360)).toBe(2.5);
    expect(windowStartFor(0, 24, 360)).toBe(-7.5);
  });
});

describe("itemBox", () => {
  it("places an item by its start and length", () => {
    expect(itemBox(12, 4, 2.5, 24)).toEqual({ left: 228, width: 96 });
  });

  it("goes left of the lane for an item that began before the window", () => {
    expect(itemBox(120, 150, 150, 6)).toEqual({ left: -180, width: 900 });
  });
});

describe("itemVisible", () => {
  it("is false for an item wholly outside the lane", () => {
    expect(itemVisible({ left: -240, width: 48 }, 360)).toBe(false);
    expect(itemVisible({ left: 366.5, width: 10 }, 360)).toBe(false);
  });

  it("keeps an item that touches the edge or sits in the 6 px bleed", () => {
    expect(itemVisible({ left: 360, width: 48 }, 360)).toBe(true);
    expect(itemVisible({ left: -50, width: 48 }, 360)).toBe(true);
    expect(itemVisible({ left: -60, width: 48 }, 360)).toBe(false);
    expect(itemVisible({ left: -100, width: 500 }, 360)).toBe(true);
  });
});

describe("laneMuteLook", () => {
  it("is not silent when off", () => {
    expect(laneMuteLook("off")).toEqual({ silent: false, description: "" });
  });

  it("says why a lane is silent in the header's words", () => {
    expect(laneMuteLook("saved")).toEqual({
      silent: true,
      description: "Muted in the mix",
    });
    expect(laneMuteLook("listen")).toEqual({
      silent: true,
      description: "Muted for you only",
    });
    expect(laneMuteLook("implied")).toEqual({
      silent: true,
      description: "Silent while another track is soloed",
    });
  });
});
