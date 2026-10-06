import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LONG_PRESS_MS,
  SWIPE_MAX_TRANSLATE_PX,
  SWIPE_MIN_DX_PX,
  swipeDragOffset,
  TOUCH_SLOP_PX,
} from "./gestureConstants";

describe("platform long-press conventions", () => {
  it("holds for iOS's 0.5 s, inside Android's 400-500 ms", () => {
    expect(LONG_PRESS_MS).toBe(500);
  });

  it("lets a held finger drift iOS's 10 pt (Android scrolls after 8 dp)", () => {
    expect(TOUCH_SLOP_PX).toBe(10);
  });

  it("times the long-press motion token with the same hold", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(
      join(here, "../styles/theme/tokens.css"),
      "utf8",
    );
    expect(tokens).toContain(`--motion-long-press: ${LONG_PRESS_MS}ms;`);
  });
});

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
