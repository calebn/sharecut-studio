import { describe, expect, it } from "vitest";
import {
  expandGhostSourceRange,
  type GhostWord,
  ghostPlacementForExpand,
  ghostWordsForExpandPreview,
} from "./ghostPreview";

const words: GhostWord[] = [
  {
    track_id: "h",
    word_index: 0,
    text: "alpha",
    start: 10,
    end: 10.5,
  },
  {
    track_id: "h",
    word_index: 1,
    text: "bravo",
    start: 10.5,
    end: 11.2,
  },
  {
    track_id: "h",
    word_index: 2,
    text: "charlie",
    start: 11.5,
    end: 12,
  },
];

describe("ghostPreview", () => {
  it("selects cutaway words covered by a roll-later expand", () => {
    const range = expandGhostSourceRange({
      kind: "roll",
      deltaSec: 0.8,
      leftSourceEnd: 10,
      rightSourceStart: 15,
    });
    expect(range).toEqual({ start: 10, end: 10.8 });
    const ghost = ghostWordsForExpandPreview(words, range);
    expect(ghost.map((w) => w.text)).toEqual(["alpha", "bravo"]);
    expect(ghostPlacementForExpand({ kind: "roll", deltaSec: 0.8 })).toBe(
      "before",
    );
  });

  it("selects words for roll-earlier expand on the right", () => {
    const range = expandGhostSourceRange({
      kind: "roll",
      deltaSec: -0.7,
      leftSourceEnd: 10,
      rightSourceStart: 15,
    });
    expect(range).toEqual({ start: 14.3, end: 15 });
    expect(ghostPlacementForExpand({ kind: "roll", deltaSec: -0.7 })).toBe(
      "after",
    );
  });

  it("returns no ghosts when not expanding", () => {
    expect(
      expandGhostSourceRange({
        kind: "roll",
        deltaSec: 0,
        leftSourceEnd: 10,
        rightSourceStart: 15,
      }),
    ).toBeNull();
    expect(ghostWordsForExpandPreview(words, null)).toEqual([]);
  });
});
