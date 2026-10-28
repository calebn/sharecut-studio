import { describe, expect, it } from "vitest";
import { type FrameFitSizes, frameFolds } from "./useShortFrame";

const fits: FrameFitSizes = {
  frameHeight: 700,
  headerHeight: 60,
  playerHeight: 80,
  tabsHeight: 56,
  rowsHeight: 0,
  lanesMin: 200,
  laneAreaHeight: 0,
  cornerHeight: 0,
};

describe("frameFolds", () => {
  it("keeps a frame that holds the header, Player, tab bar and lanes", () => {
    expect(frameFolds(fits)).toBe(false);
    expect(frameFolds({ ...fits, frameHeight: 396 })).toBe(false);
  });

  it("folds one pixel below the total", () => {
    expect(frameFolds({ ...fits, frameHeight: 395 })).toBe(true);
  });

  it("counts the Edit rows a fold takes away", () => {
    expect(frameFolds({ ...fits, frameHeight: 396, rowsHeight: 47 })).toBe(
      true,
    );
    expect(frameFolds({ ...fits, frameHeight: 443, rowsHeight: 47 })).toBe(
      false,
    );
  });

  it("folds sooner as the header wraps taller", () => {
    expect(frameFolds({ ...fits, frameHeight: 450 })).toBe(false);
    expect(frameFolds({ ...fits, frameHeight: 450, headerHeight: 150 })).toBe(
      true,
    );
  });

  it("folds when the corner would leave the lanes less than their floor", () => {
    const edit = { ...fits, laneAreaHeight: 254, cornerHeight: 54 };
    expect(frameFolds(edit)).toBe(false);
    expect(frameFolds({ ...edit, cornerHeight: 55 })).toBe(true);
    expect(frameFolds({ ...edit, laneAreaHeight: 253 })).toBe(true);
  });

  it("folds the 844x390 Edit frame, whose lane area is exactly the lanes' floor", () => {
    const edit = {
      ...fits,
      frameHeight: 390,
      headerHeight: 49,
      playerHeight: 56,
      tabsHeight: 0,
      lanesMin: 192,
      laneAreaHeight: 192,
      cornerHeight: 54,
    };
    expect(frameFolds(edit)).toBe(true);
    expect(frameFolds({ ...edit, cornerHeight: 0 })).toBe(false);
  });

  it("never folds on a size that did not measure", () => {
    expect(frameFolds({ ...fits, frameHeight: 0 })).toBe(false);
    expect(frameFolds({ ...fits, lanesMin: Number.NaN })).toBe(false);
  });
});

describe("frameFolds on a frame with no Player", () => {
  it("fits a Record-like frame whose tab bar is measured at its natural height", () => {
    const record = {
      frameHeight: 844,
      headerHeight: 45,
      playerHeight: 0,
      tabsHeight: 56,
      rowsHeight: 0,
      lanesMin: 192,
      laneAreaHeight: 0,
      cornerHeight: 0,
    };
    expect(frameFolds(record)).toBe(false);
    expect(frameFolds({ ...record, tabsHeight: 682 })).toBe(true);
  });
});
