import { describe, expect, it } from "vitest";
import {
  type FollowCandidate,
  followScrollTop,
  LEAD_HOLD_SEC,
  nextFollowLead,
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

  it("lets an audible word on the other lane win once a word-less pick has been held too long", () => {
    const prev = { trackId: "dani", sec: 12, wordlessSince: 10 };
    expect(pickFollowCandidate([dani(3), vicky(0, "0.1")], prev, 12)).toEqual(
      vicky(0, "0.1"),
    );
  });

  it("keeps a word-less same-lane pick within the hold", () => {
    const prev = { trackId: "dani", sec: 10.4, wordlessSince: 10 };
    expect(pickFollowCandidate([dani(3), vicky(0, "0.1")], prev, 10.4)).toEqual(
      dani(3),
    );
  });

  it("keeps a long word-less pick when the other lane has no audible word", () => {
    const prev = { trackId: "dani", sec: 12, wordlessSince: 10 };
    expect(pickFollowCandidate([dani(3), vicky(0)], prev, 12)).toEqual(dani(3));
  });

  it("prefers a word-active candidate, then the lowest index", () => {
    expect(pickFollowCandidate([dani(2), dani(1, "1.0")], null, 1)).toEqual(
      dani(1, "1.0"),
    );
    expect(pickFollowCandidate([vicky(5), dani(2)], null, 1)).toEqual(dani(2));
  });
});

describe("nextFollowLead", () => {
  it("starts the word-less clock on a word-less pick and keeps it on the same lane", () => {
    const first = nextFollowLead(null, dani(3), 10);
    expect(first).toEqual({ trackId: "dani", sec: 10, wordlessSince: 10 });
    expect(nextFollowLead(first, dani(3), 11)).toEqual({
      trackId: "dani",
      sec: 11,
      wordlessSince: 10,
    });
  });

  it("clears the clock when a word is audible or the lane changes", () => {
    const wordless = { trackId: "dani", sec: 10, wordlessSince: 9 };
    expect(nextFollowLead(wordless, dani(3, "3.0"), 11)).toEqual({
      trackId: "dani",
      sec: 11,
    });
    expect(nextFollowLead(wordless, vicky(1), 11)).toEqual({
      trackId: "vicky",
      sec: 11,
      wordlessSince: 11,
    });
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
