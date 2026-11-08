import { describe, expect, it } from "vitest";
import { reviewCompletenessOf, reviewSubsetCount } from "./reviewCompleteness";
import type { ReviewItem } from "./reviewQueueModel";

const items: readonly ReviewItem[] = [
  { id: "suggestion", kind: "filler", at: 1, savedSeconds: 0.4 },
  { id: "comment", kind: "comment", at: 2, savedSeconds: 0 },
  { id: "word", kind: "unsure-word", at: 3, savedSeconds: 0 },
  {
    id: "decided",
    kind: "filler",
    at: 4,
    savedSeconds: 0.2,
    result: "kept",
  },
];

describe("reviewCompletenessOf", () => {
  it.each(["pending", "failed"] as const)(
    "keeps total and word-filter counts unknown while Detail is %s",
    (detail) => {
      expect(reviewCompletenessOf(items, detail)).toEqual({
        counts: {
          all: null,
          suggestions: 1,
          comments: 1,
          checks: null,
        },
        total: null,
        undecided: null,
        wordsKnown: false,
        unavailableMessage:
          detail === "pending"
            ? "Transcript words are loading."
            : "Transcript words could not be loaded.",
      });
      expect(reviewSubsetCount(1, detail)).toBe(1);
      expect(reviewSubsetCount(1, detail, true)).toBeNull();
    },
  );

  it("uses current queue totals when Detail is ready or not supplied", () => {
    expect(reviewCompletenessOf(items, "ready")).toMatchObject({
      counts: { all: 3, suggestions: 1, comments: 1, checks: 1 },
      total: 4,
      undecided: 3,
      wordsKnown: true,
      unavailableMessage: null,
    });
    expect(reviewCompletenessOf(items, undefined).total).toBe(4);
    expect(reviewSubsetCount(1, "ready", true)).toBe(1);
  });

  it("keeps hidden word detail unknown while absent detail remains independent", () => {
    expect(reviewCompletenessOf(items, "hidden")).toMatchObject({
      counts: { all: null, checks: null, suggestions: 1, comments: 1 },
      total: null,
      undecided: null,
      wordsKnown: false,
      unavailableMessage: "Transcript words are unavailable here.",
    });
    expect(reviewCompletenessOf(items, undefined).wordsKnown).toBe(true);
  });
});
