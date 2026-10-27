import { describe, expect, it } from "vitest";
import { type FrameFitSizes, frameFolds } from "./useShortFrame";

const fits: FrameFitSizes = {
  frameHeight: 700,
  headerHeight: 60,
  playerHeight: 80,
  tabsHeight: 56,
  lanesMin: 200,
  laneHeight: 84,
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

  it("folds sooner as the header wraps taller", () => {
    expect(frameFolds({ ...fits, frameHeight: 450 })).toBe(false);
    expect(frameFolds({ ...fits, frameHeight: 450, headerHeight: 150 })).toBe(
      true,
    );
  });

  it("folds when the corner would cover more than the foot of one lane", () => {
    const edit = { ...fits, laneAreaHeight: 205, cornerHeight: 54 };
    expect(frameFolds(edit)).toBe(false);
    expect(frameFolds({ ...edit, cornerHeight: 202 })).toBe(true);
    // 205 - 89 = 116 is exactly the lanes' floor less one lane.
    expect(frameFolds({ ...edit, cornerHeight: 89 })).toBe(false);
    expect(frameFolds({ ...edit, cornerHeight: 90 })).toBe(true);
  });

  it("never folds on a size that did not measure", () => {
    expect(frameFolds({ ...fits, frameHeight: 0 })).toBe(false);
    expect(frameFolds({ ...fits, lanesMin: Number.NaN })).toBe(false);
  });
});
