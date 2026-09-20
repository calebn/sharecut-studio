import { describe, expect, it, vi } from "vitest";
import {
  canSuggestSkip,
  paddedAuditionWindow,
  playAbRange,
  playSuggestedRange,
  playTimelineRange,
  suggestDisabledReason,
} from "./playRange";

const skippable = {
  type: "remove",
  scope: "session",
  mappable: true,
  timeline_start: 10,
  timeline_end: 12,
};

describe("paddedAuditionWindow", () => {
  it("pads and clamps to zero", () => {
    expect(paddedAuditionWindow(10, 12, 0.5)).toEqual({
      start: 9.5,
      end: 12.5,
    });
    expect(paddedAuditionWindow(0.1, 0.2, 0.5).start).toBe(0);
  });
});

describe("canSuggestSkip", () => {
  it("allows session-scope mappable removes", () => {
    expect(canSuggestSkip(skippable)).toBe(true);
  });

  it("prefers server can_skip when present", () => {
    expect(
      canSuggestSkip({ ...skippable, type: "split", can_skip: true }),
    ).toBe(true);
    expect(canSuggestSkip({ ...skippable, can_skip: false })).toBe(false);
  });

  it("rejects splits, punches, and unmapped cuts", () => {
    expect(canSuggestSkip({ ...skippable, type: "split" })).toBe(false);
    expect(canSuggestSkip({ ...skippable, scope: "track" })).toBe(false);
    expect(canSuggestSkip({ ...skippable, mappable: false })).toBe(false);
  });
});

describe("suggestDisabledReason", () => {
  it("explains split and track punch", () => {
    expect(suggestDisabledReason({ ...skippable, type: "split" })).toMatch(
      /split/i,
    );
    expect(suggestDisabledReason({ ...skippable, scope: "track" })).toMatch(
      /Track punch/i,
    );
    expect(suggestDisabledReason({ ...skippable, type: "mute" })).toMatch(
      /Mute-in-place/i,
    );
    expect(suggestDisabledReason(skippable)).toBeNull();
  });

  it("uses skip_reason from the pending view", () => {
    expect(
      suggestDisabledReason({
        ...skippable,
        can_skip: false,
        skip_reason: "This cut is too short for a Suggested skip.",
      }),
    ).toMatch(/too short/i);
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

describe("playSuggestedRange / playAbRange", () => {
  it("sets skip for suggested", () => {
    const beginAudition = vi.fn();
    playSuggestedRange({
      skipStart: 10,
      skipEnd: 12,
      padSec: 0.5,
      beginAudition,
    });
    expect(beginAudition).toHaveBeenCalledWith({
      playheadSec: 9.5,
      untilSec: 12.5,
      skip: { start: 10, end: 12 },
    });
  });

  it("queues suggested skip as A/B followup", () => {
    const beginAudition = vi.fn();
    playAbRange({
      skipStart: 10,
      skipEnd: 12,
      padSec: 0.5,
      gapSec: 0.4,
      beginAudition,
    });
    expect(beginAudition).toHaveBeenCalledWith({
      playheadSec: 9.5,
      untilSec: 12.5,
      abFollowup: {
        start: 9.5,
        until: 12.5,
        skipStart: 10,
        skipEnd: 12,
        gapSec: 0.4,
      },
    });
  });
});
