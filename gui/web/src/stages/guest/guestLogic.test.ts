import { describe, expect, it } from "vitest";
import {
  anchorAfterTyping,
  anchorSeconds,
  canComment,
  guestStages,
  isPostKey,
  postedName,
  reanchor,
  wordAtSeconds,
} from "./guestLogic";

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

describe("composer anchor", () => {
  it.each([
    ["first keystroke pins the playhead", null, "h", 12, 12],
    ["later keystrokes keep the pin", 12, "hi", 30, 12],
    ["whitespace alone does not pin", null, "  ", 12, null],
    ["clearing the field lets it follow", 12, "", 30, null],
  ])("%s", (_name, pinnedAt, body, playhead, expected) => {
    expect(anchorAfterTyping({ pinnedAt }, body, playhead).pinnedAt).toBe(
      expected,
    );
  });

  it("re-anchors only a pinned time", () => {
    expect(reanchor({ pinnedAt: 12 }, 40)).toEqual({ pinnedAt: 40 });
    expect(reanchor({ pinnedAt: null }, 40)).toEqual({ pinnedAt: null });
  });

  it("reads the pin, else the playhead", () => {
    expect(anchorSeconds({ pinnedAt: 12 }, 40)).toBe(12);
    expect(anchorSeconds({ pinnedAt: null }, 40)).toBe(40);
  });
});

describe("isPostKey", () => {
  it.each([
    ["Enter", false, false, true],
    ["Enter", true, false, false],
    ["Enter", false, true, false],
    ["a", false, false, false],
  ])("%s shift=%s composing=%s", (key, shiftKey, isComposing, expected) => {
    expect(isPostKey({ key, shiftKey, isComposing })).toBe(expected);
  });
});

describe("postedName", () => {
  it.each([
    ["", "Guest"],
    ["   ", "Guest"],
    ["  Dana  Reyes ", "Dana Reyes"],
    ["<b>", "b"],
  ])("%j posts as %j", (name, shown) => {
    expect(postedName(name)).toBe(shown);
  });
});
