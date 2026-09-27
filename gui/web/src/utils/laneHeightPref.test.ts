import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampLaneHeightPx,
  DEFAULT_LANE_HEIGHT_PREF,
  LANE_HEIGHT_STORAGE_KEY,
  parseLaneHeightPref,
  readLaneHeightPref,
  stepLaneHeightPx,
  writeLaneHeightPref,
} from "./laneHeightPref";

afterEach(() => {
  localStorage.removeItem(LANE_HEIGHT_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("clampLaneHeightPx", () => {
  it("clamps below the floor", () => {
    expect(clampLaneHeightPx(50)).toBe(72);
  });

  it("clamps above the ceiling", () => {
    expect(clampLaneHeightPx(300)).toBe(240);
  });

  it("rounds fractional values", () => {
    expect(clampLaneHeightPx(150.6)).toBe(151);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampLaneHeightPx(NaN)).toBe(104);
  });
});

describe("stepLaneHeightPx", () => {
  it("steps up through the list", () => {
    expect(stepLaneHeightPx(104, "up")).toBe(144);
    expect(stepLaneHeightPx(144, "up")).toBe(192);
    expect(stepLaneHeightPx(192, "up")).toBe(240);
  });

  it("holds at the top", () => {
    expect(stepLaneHeightPx(240, "up")).toBe(240);
  });

  it("steps down through the list", () => {
    expect(stepLaneHeightPx(104, "down")).toBe(72);
  });

  it("holds at the bottom", () => {
    expect(stepLaneHeightPx(72, "down")).toBe(72);
  });

  it("steps an off-list value to the next entry above or below", () => {
    expect(stepLaneHeightPx(150, "up")).toBe(192);
    expect(stepLaneHeightPx(150, "down")).toBe(144);
  });
});

describe("parseLaneHeightPref", () => {
  it("falls back to default for null", () => {
    expect(parseLaneHeightPref(null)).toEqual(DEFAULT_LANE_HEIGHT_PREF);
  });

  it("falls back to default for garbage JSON", () => {
    expect(parseLaneHeightPref("{not json")).toEqual(DEFAULT_LANE_HEIGHT_PREF);
  });

  it("falls back to default for an invalid mode", () => {
    expect(
      parseLaneHeightPref(JSON.stringify({ mode: "huge", px: 100 })),
    ).toEqual(DEFAULT_LANE_HEIGHT_PREF);
  });

  it("keeps a valid fit preference", () => {
    expect(
      parseLaneHeightPref(JSON.stringify({ mode: "fit", px: 192 })),
    ).toEqual({ mode: "fit", px: 192 });
  });

  it("clamps an out-of-range fixed px", () => {
    expect(
      parseLaneHeightPref(JSON.stringify({ mode: "fixed", px: 9999 })),
    ).toEqual({ mode: "fixed", px: 240 });
  });
});

describe("persistence", () => {
  it("round-trips through write then read", () => {
    writeLaneHeightPref({ mode: "fit", px: 192 });
    expect(readLaneHeightPref()).toEqual({ mode: "fit", px: 192 });
  });

  it("writes the raw JSON shape localStorage holds", () => {
    writeLaneHeightPref({ mode: "fixed", px: 144 });
    expect(localStorage.getItem(LANE_HEIGHT_STORAGE_KEY)).toBe(
      JSON.stringify({ mode: "fixed", px: 144 }),
    );
  });

  it("falls back to default when Storage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLaneHeightPref()).toEqual(DEFAULT_LANE_HEIGHT_PREF);
  });
});
