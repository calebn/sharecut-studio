import { describe, expect, it } from "vitest";
import {
  clampClipFades,
  clampFadeMs,
  edgeFadeMaxMs,
  joinLengthMaxMs,
  maxFadeMs,
} from "./fadeLimits";

describe("maxFadeMs", () => {
  it("floors the clip length to whole ms and never goes negative", () => {
    expect(maxFadeMs(0.0259, null)).toBe(25);
    expect(maxFadeMs(-1, 40)).toBe(0);
    expect(edgeFadeMaxMs(-1, null, 0)).toBe(0);
  });

  it("takes the smaller of the track cap and the clip length", () => {
    expect(maxFadeMs(2, 40)).toBe(40);
    expect(maxFadeMs(0.025, 40)).toBe(25);
  });
  it("is the clip length when the track is uncapped", () => {
    expect(maxFadeMs(2, null)).toBe(2000);
    expect(maxFadeMs(2)).toBe(2000);
  });
});

describe("clampFadeMs", () => {
  it("rounds and clamps into [0, max]", () => {
    expect(clampFadeMs(500.4, 40)).toBe(40);
    expect(clampFadeMs(-5, 40)).toBe(0);
    expect(clampFadeMs(12.6, 40)).toBe(13);
  });
});

describe("edgeFadeMaxMs", () => {
  it("leaves room for the other edge's fade", () => {
    expect(edgeFadeMaxMs(2, null, 1500)).toBe(500);
    expect(edgeFadeMaxMs(0.06, 40, 40)).toBe(20);
    expect(edgeFadeMaxMs(2, 40, 0)).toBe(40);
    expect(edgeFadeMaxMs(1, null, 5000)).toBe(0);
  });
});

describe("joinLengthMaxMs", () => {
  it("is the min of the left's remaining room and the right's cap, uncapped", () => {
    expect(
      joinLengthMaxMs(
        { durationSec: 2, fadeInMs: 500 },
        { durationSec: 3 },
        null,
      ),
    ).toBe(1500);
  });

  it("a track fade cap wins over both edges' room", () => {
    expect(
      joinLengthMaxMs({ durationSec: 2, fadeInMs: 0 }, { durationSec: 2 }, 40),
    ).toBe(40);
  });

  it("the left clip's fade-in eats into the room its fade-out can take", () => {
    expect(
      joinLengthMaxMs(
        { durationSec: 0.06, fadeInMs: 40 },
        { durationSec: 2 },
        null,
      ),
    ).toBe(20);
  });

  it("never goes negative", () => {
    expect(
      joinLengthMaxMs(
        { durationSec: 0.01, fadeInMs: 50 },
        { durationSec: 2 },
        null,
      ),
    ).toBe(0);
  });
});

describe("clampClipFades", () => {
  it("clamps fade-in first, then fade-out to what is left, like set_clip_fade", () => {
    expect(clampClipFades(5000, 5000, 2, null)).toEqual({
      inMs: 2000,
      outMs: 0,
    });
    expect(clampClipFades(1500, 1500, 2, null)).toEqual({
      inMs: 1500,
      outMs: 500,
    });
    expect(clampClipFades(40, 40, 0.06, 40)).toEqual({ inMs: 40, outMs: 20 });
    expect(clampClipFades(500, 0, 2, 40)).toEqual({ inMs: 40, outMs: 0 });
  });
});
