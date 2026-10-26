import { describe, expect, it } from "vitest";
import { QUEUE_ITEMS } from "../storybook/reviewFixtures";
import {
  decidedItems,
  decisionMessage,
  filterCounts,
  filterItems,
  groupQueue,
  progressLine,
  type ReviewItem,
  resultText,
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

  it("counts only what the bulk will cut, as one number", () => {
    const fillers = groupQueue(QUEUE_ITEMS).find((g) => g.kind === "filler");
    expect(fillers?.bulk?.verb).toBe("cut");
    expect(fillers?.bulk?.ids).toEqual(["f1", "f2", "f4"]);
    expect(fillers?.bulk?.savedSeconds).toBeCloseTo(0.8 + 0.6 + 0.7);
  });

  it("leaves unsure, blocked and decided items out of the bulk", () => {
    const rows = [
      item({ id: "a" }),
      item({ id: "b", unsure: true }),
      item({ id: "c", blocked: true }),
      item({ id: "d", result: "kept" }),
    ];
    expect(groupQueue(rows)[0]?.bulk?.ids).toEqual(["a"]);
    expect(groupQueue([item({ id: "b", blocked: true })])[0]?.bulk).toBeNull();
  });

  it("never offers a bulk on checks, words or comments", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    for (const kind of ["check", "unsure-word", "comment"]) {
      expect(groups.find((g) => g.kind === kind)?.bulk).toBeNull();
    }
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

  it("lists decided items", () => {
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

describe("decisionMessage", () => {
  it("names one decision and sums a bulk", () => {
    expect(decisionMessage(QUEUE_ITEMS, ["f1"], "applied")).toBe("Cut 0.8 s");
    expect(decisionMessage(QUEUE_ITEMS, ["f1", "f2"], "applied")).toBe(
      "Cut 2 · saves 1.4 s",
    );
    expect(decisionMessage(QUEUE_ITEMS, ["f1", "f2"], "kept")).toBe("Kept 2");
  });
});
