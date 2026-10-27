import { describe, expect, it } from "vitest";
import { canComment, guestStages, wordAtSeconds } from "./guestLogic";

describe("guestStages and canComment", () => {
  it.each([
    ["viewer", null, false],
    ["commenter", null, true],
    ["editor", ["edit", "review"], true],
  ] as const)("%s", (role, stages, comments) => {
    expect(guestStages(role)).toEqual(stages);
    expect(canComment(role)).toBe(comments);
  });
});

describe("wordAtSeconds", () => {
  const starts = [1, 2, 4, 8];
  it.each([
    [0.5, undefined],
    [1, 0],
    [1.9, 0],
    [2, 1],
    [7.99, 2],
    [8, 3],
    [100, 3],
  ])("at %s", (seconds, word) => {
    expect(wordAtSeconds(starts, seconds)).toBe(word);
  });
  it("finds nothing in no words", () => {
    expect(wordAtSeconds([], 5)).toBeUndefined();
  });
});
