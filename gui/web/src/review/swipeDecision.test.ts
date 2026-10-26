import { describe, expect, it } from "vitest";
import { releaseSwipe, SWIPE_THRESHOLD_PX, swipeState } from "./swipeDecision";

describe("swipeState", () => {
  it("uses an 80 px threshold", () => {
    expect(SWIPE_THRESHOLD_PX).toBe(80);
  });

  it("maps right to the verb, left to keep and up to next", () => {
    expect(swipeState(90, 0).intent).toBe("verb");
    expect(swipeState(-90, 0).intent).toBe("keep");
    expect(swipeState(0, -90).intent).toBe("next");
  });

  it("commits at the threshold and not before", () => {
    expect(swipeState(79, 0).committed).toBe(false);
    expect(swipeState(80, 0).committed).toBe(true);
    expect(swipeState(-80, 0).committed).toBe(true);
    expect(swipeState(0, -80).committed).toBe(true);
  });

  it("grows the icon with the distance and stops at one", () => {
    expect(swipeState(40, 0).progress).toBe(0.5);
    expect(swipeState(400, 0).progress).toBe(1);
  });

  it("follows the longer axis", () => {
    expect(swipeState(100, -60).intent).toBe("verb");
    expect(swipeState(30, -100).intent).toBe("next");
  });

  it("does nothing for a downward drag", () => {
    expect(swipeState(0, 120)).toEqual({
      intent: null,
      progress: 0,
      committed: false,
    });
  });
});

describe("releaseSwipe", () => {
  it("decides past the threshold", () => {
    expect(releaseSwipe(100, 10)).toEqual({
      commit: "verb",
      springBack: false,
    });
    expect(releaseSwipe(-100, 10)).toEqual({
      commit: "keep",
      springBack: false,
    });
    expect(releaseSwipe(5, -100)).toEqual({
      commit: "next",
      springBack: false,
    });
  });

  it("springs back below the threshold", () => {
    expect(releaseSwipe(79, 0)).toEqual({ commit: null, springBack: true });
    expect(releaseSwipe(0, -79)).toEqual({ commit: null, springBack: true });
  });

  it("has nothing to spring back from a tap", () => {
    expect(releaseSwipe(0, 0)).toEqual({ commit: null, springBack: false });
  });
});
