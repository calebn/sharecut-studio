import { describe, expect, it } from "vitest";
import { QUEUE_ITEMS } from "../storybook/reviewFixtures";
import {
  bulkEligible,
  decidedItems,
  filterCounts,
  filterItems,
  groupQueue,
  progressLine,
  type ReviewItem,
  resultText,
  secondsSaved,
} from "./reviewQueue";

const item = (over: Partial<ReviewItem>): ReviewItem => ({
  id: "x",
  kind: "filler",
  at: 0,
  savedSeconds: 0.5,
  ...over,
});

describe("groupQueue", () => {
  it("orders groups by kind and items by time, undecided only", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    expect(groups.map((g) => g.kind)).toEqual([
      "check",
      "unsure-word",
      "comment",
      "filler",
      "pause",
      "sound",
    ]);
    expect(groups[3]?.items.map((i) => i.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("offers one bulk verb per cut group with the seconds as one number", () => {
    const fillers = groupQueue(QUEUE_ITEMS).find((g) => g.kind === "filler");
    expect(fillers?.bulk?.verb).toBe("cut");
    expect(fillers?.bulk?.ids).toEqual(["f1", "f2", "f4"]);
    expect(fillers?.bulk?.savedSeconds).toBeCloseTo(
      (fillers?.savedSeconds ?? 0) -
        (QUEUE_ITEMS.find((i) => i.id === "f3")?.savedSeconds ?? 0),
    );
  });

  it("never offers a bulk on checks, words or comments", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    for (const kind of ["check", "unsure-word", "comment"]) {
      expect(groups.find((g) => g.kind === kind)?.bulk).toBeNull();
    }
  });
});

describe("bulkEligible", () => {
  it("excludes unsure, blocked and decided items", () => {
    expect(bulkEligible(item({}))).toBe(true);
    expect(bulkEligible(item({ unsure: true }))).toBe(false);
    expect(bulkEligible(item({ blocked: true }))).toBe(false);
    expect(bulkEligible(item({ result: "kept" }))).toBe(false);
  });
});

describe("counts and progress", () => {
  it("counts undecided items per filter", () => {
    expect(filterCounts(QUEUE_ITEMS)).toEqual({
      all: 10,
      suggestions: 7,
      comments: 1,
      checks: 2,
    });
    expect(filterItems(QUEUE_ITEMS, "comments").map((i) => i.id)).toEqual([
      "m1",
    ]);
  });

  it("counts only applied items as saved", () => {
    expect(secondsSaved(QUEUE_ITEMS)).toBeCloseTo(0.5);
    expect(decidedItems(QUEUE_ITEMS).map((i) => i.id)).toEqual(["f0", "p0"]);
  });

  it("writes one progress sentence", () => {
    expect(progressLine(QUEUE_ITEMS)).toBe("2 of 12 decided · saves 0.5 s");
  });
});

describe("resultText", () => {
  it("names what was done", () => {
    expect(resultText(item({ result: "applied", savedSeconds: 0.8 }))).toBe(
      "Cut 0.8 s",
    );
    expect(resultText(item({ result: "kept" }))).toBe("Kept");
  });
});
