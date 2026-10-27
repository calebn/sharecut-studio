import { describe, expect, it } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import type { ScriptTurn } from "../../system/scriptPieces";
import { findCountText, findMatches } from "./findMatches";

describe("findMatches", () => {
  it("finds a word in every turn as a span of its index", () => {
    expect(findMatches(SCRIPT_TURNS, "room", false)).toEqual([
      { start: 13, end: 13 },
      { start: 32, end: 32 },
    ]);
  });

  it("covers every word a phrase touches", () => {
    expect(findMatches(SCRIPT_TURNS, "small room", false)).toEqual([
      { start: 12, end: 13 },
    ]);
    expect(findMatches(SCRIPT_TURNS, "found the micro", false)).toEqual([
      { start: 37, end: 39 },
    ]);
  });

  it("finds part of a word and counts the word whole", () => {
    expect(findMatches(SCRIPT_TURNS, "icroph", false)).toEqual([
      { start: 39, end: 39 },
    ]);
  });

  it("does not match across turns", () => {
    expect(findMatches(SCRIPT_TURNS, "one. Thanks", false)).toEqual([]);
  });

  it("matches case only when asked", () => {
    expect(findMatches(SCRIPT_TURNS, "WELCOME", false)).toEqual([
      { start: 0, end: 0 },
    ]);
    expect(findMatches(SCRIPT_TURNS, "WELCOME", true)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "Welcome", true)).toEqual([
      { start: 0, end: 0 },
    ]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findMatches(SCRIPT_TURNS, "", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "   ", false)).toEqual([]);
  });

  it("ignores spaces around the query and reports a word holding two hits once", () => {
    const turn: ScriptTurn = {
      ...SCRIPT_TURNS[0],
      words: [
        { index: 7, text: "banana" },
        { index: 8, text: "split" },
      ],
    };
    expect(findMatches([turn], "  an ", false)).toEqual([{ start: 7, end: 7 }]);
    expect(findMatches([turn], "a split", false)).toEqual([
      { start: 7, end: 8 },
    ]);
  });
});

describe("findCountText", () => {
  it("counts from one, says when nothing matches and stays silent for no query", () => {
    expect(findCountText("room", 12, 2)).toBe("3 of 12");
    expect(findCountText("room", 1, 0)).toBe("1 of 1");
    expect(findCountText("zzz", 0, -1)).toBe("No matches");
    expect(findCountText("  ", 0, -1)).toBe("");
    expect(findCountText("", 5, 0)).toBe("");
  });
});
