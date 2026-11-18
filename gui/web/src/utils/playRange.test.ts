import { describe, expect, it, vi } from "vitest";
import { paddedAuditionWindow, playTimelineRange } from "./playRange";

describe("paddedAuditionWindow", () => {
  it("pads and clamps to zero", () => {
    expect(paddedAuditionWindow(10, 12, 0.5)).toEqual({
      start: 9.5,
      end: 12.5,
    });
    expect(paddedAuditionWindow(0.1, 0.2, 0.5).start).toBe(0);
  });
});

describe("playTimelineRange", () => {
  it("begins the padded audition", () => {
    const beginAudition = vi.fn();
    playTimelineRange({
      start: 10,
      end: 12,
      padSec: 0.5,
      beginAudition,
    });
    expect(beginAudition).toHaveBeenCalledWith({
      playheadSec: 9.5,
      untilSec: 12.5,
    });
  });
});
