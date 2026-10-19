import { describe, expect, it } from "vitest";
import {
  type FollowCandidate,
  followScrollTop,
  LEAD_HOLD_SEC,
  pickFollowCandidate,
} from "./transcriptFollow";

const dani = (i: number, wordKey: string | null = null): FollowCandidate => ({
  utteranceIndex: i,
  trackId: "dani",
  wordKey,
});
const vicky = (i: number, wordKey: string | null = null): FollowCandidate => ({
  utteranceIndex: i,
  trackId: "vicky",
  wordKey,
});

describe("pickFollowCandidate", () => {
  it("returns null with nothing active", () => {
    expect(pickFollowCandidate([], null, 1)).toBeNull();
  });

  it("stays on the lead lane while it is active, whatever the other does", () => {
    const prev = { trackId: "dani", sec: 10 };
    expect(
      pickFollowCandidate([vicky(0, "0.1"), dani(3, "3.0")], prev, 10.2),
    ).toEqual(dani(3, "3.0"));
  });

  it("holds the target when the lead lane pauses under an interjection", () => {
    const prev = { trackId: "dani", sec: 10 };
    expect(pickFollowCandidate([vicky(0, "0.1")], prev, 10.4)).toBeNull();
  });

  it("switches once the hold passes", () => {
    const prev = { trackId: "dani", sec: 10 };
    expect(
      pickFollowCandidate([vicky(0, "0.1")], prev, 10 + LEAD_HOLD_SEC + 0.01),
    ).toEqual(vicky(0, "0.1"));
  });

  it("switches at once on a seek", () => {
    const prev = { trackId: "dani", sec: 10 };
    expect(pickFollowCandidate([vicky(0, "0.1")], prev, 3)).toEqual(
      vicky(0, "0.1"),
    );
  });

  it("prefers a word-active candidate, then the lowest index", () => {
    expect(pickFollowCandidate([dani(2), dani(1, "1.0")], null, 1)).toEqual(
      dani(1, "1.0"),
    );
    expect(pickFollowCandidate([vicky(5), dani(2)], null, 1)).toEqual(dani(2));
  });
});

describe("followScrollTop", () => {
  const base = { scrollTop: 500, clientHeight: 400, scrollHeight: 3000 };
  it("does not scroll while the line stays in the comfort band", () => {
    for (const itemTop of [120, 190, 270]) {
      expect(followScrollTop({ ...base, itemTop, itemHeight: 20 })).toBeNull();
    }
  });
  it("recenters a line that left the band", () => {
    expect(followScrollTop({ ...base, itemTop: 350, itemHeight: 20 })).toBe(
      660,
    );
    expect(followScrollTop({ ...base, itemTop: 10, itemHeight: 20 })).toBe(320);
  });
  it("clamps at the ends", () => {
    expect(
      followScrollTop({ ...base, scrollTop: 10, itemTop: 5, itemHeight: 10 }),
    ).toBe(0);
  });
});
