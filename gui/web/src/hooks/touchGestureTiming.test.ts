import { describe, expect, it } from "vitest";
import {
  SWIPE_MAX_TRANSLATE_PX,
  SWIPE_MIN_DX_PX,
  swipeDragOffset,
} from "./touchGestureTiming";

describe("swipeDragOffset", () => {
  it("clamps rightward drags to 0", () => {
    expect(swipeDragOffset(10)).toBe(0);
    expect(swipeDragOffset(0)).toBe(0);
  });

  it("passes small leftward drags through unchanged", () => {
    expect(swipeDragOffset(-20)).toBe(-20);
  });

  it("caps large leftward drags at -SWIPE_MAX_TRANSLATE_PX", () => {
    expect(swipeDragOffset(-500)).toBe(-SWIPE_MAX_TRANSLATE_PX);
  });

  it("derives the cap from the resolve threshold", () => {
    expect(SWIPE_MAX_TRANSLATE_PX).toBe(2 * SWIPE_MIN_DX_PX);
  });
});
