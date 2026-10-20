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
  it("uses beginAudition when provided", () => {
    const beginAudition = vi.fn();
    playTimelineRange({
      start: 10,
      end: 12,
      padSec: 0.5,
      beginAudition,
      setPlayheadSec: vi.fn(),
      setPlayUntilSec: vi.fn(),
      setIsPlaying: vi.fn(),
    });
    expect(beginAudition).toHaveBeenCalledWith({
      playheadSec: 9.5,
      untilSec: 12.5,
    });
  });
});
