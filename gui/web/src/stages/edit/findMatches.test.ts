import { describe, expect, it } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import type { ScriptTurn } from "../../system/scriptPieces";
import { findCountText, findMatches, replacementOk } from "./findMatches";

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
    expect(findMatches(SCRIPT_TURNS, "found the microphones", false)).toEqual([
      { start: 37, end: 39 },
    ]);
  });

  it("matches whole words only, like the backend", () => {
    expect(findMatches(SCRIPT_TURNS, "icroph", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "micro", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "the", false)).toEqual([
      { start: 3, end: 3 },
      { start: 24, end: 24 },
      { start: 31, end: 31 },
      { start: 38, end: 38 },
    ]);
  });

  it("strips punctuation at the edges of the query and of each word", () => {
    expect(findMatches(SCRIPT_TURNS, "show", false)).toEqual([
      { start: 4, end: 4 },
    ]);
    expect(findMatches(SCRIPT_TURNS, "(show!)", false)).toEqual([
      { start: 4, end: 4 },
    ]);
    expect(findMatches(SCRIPT_TURNS, "...", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "so um", false)).toEqual([
      { start: 45, end: 46 },
    ]);
    expect(findMatches(SCRIPT_TURNS, "so you", false)).toEqual([]);
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

  it("ignores spaces around the query and between its words", () => {
    expect(findMatches(SCRIPT_TURNS, "  small   room ", false)).toEqual([
      { start: 12, end: 13 },
    ]);
  });

  it("folds each word on its own so a fold that changes the length cannot move a hit", () => {
    const turn: ScriptTurn = {
      ...SCRIPT_TURNS[0],
      words: [
        { index: 0, text: "\u0130" },
        { index: 1, text: "\u0130" },
        { index: 2, text: "a" },
        { index: 3, text: "b" },
        { index: 4, text: "Stra\u00dfe" },
      ],
    };
    expect(findMatches([turn], "a", false)).toEqual([{ start: 2, end: 2 }]);
    expect(findMatches([turn], "a b", false)).toEqual([{ start: 2, end: 3 }]);
    expect(findMatches([turn], "STRASSE", false)).toEqual([
      { start: 4, end: 4 },
    ]);
    expect(findMatches([turn], "STRASSE", true)).toEqual([]);
    expect(findMatches([turn], "\u0130", false)).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });

  it("skips muted and cut words and does not run a phrase across them", () => {
    const turn: ScriptTurn = {
      ...SCRIPT_TURNS[0],
      words: [
        { index: 0, text: "so" },
        { index: 1, text: "um", mark: { kind: "cut", id: "c", seconds: 0.4 } },
        { index: 2, text: "um", mark: { kind: "muted" } },
        { index: 3, text: "um" },
        { index: 4, text: "so" },
        { index: 5, text: "um", mark: { kind: "suggested", id: "s" } },
      ],
    };
    expect(findMatches([turn], "um", false)).toEqual([
      { start: 3, end: 3 },
      { start: 5, end: 5 },
    ]);
    expect(findMatches([turn], "so um", false)).toEqual([{ start: 4, end: 5 }]);
  });

  it("finds hits in linear time on a long turn", () => {
    const words = Array.from({ length: 50_000 }, (_, index) => ({
      index,
      text: "a",
    }));
    const turn: ScriptTurn = { ...SCRIPT_TURNS[0], words };
    const before = performance.now();
    const spans = findMatches([turn], "a", false);
    expect(spans).toHaveLength(50_000);
    expect(performance.now() - before).toBeLessThan(500);
  });
});

describe("findCountText", () => {
  it("counts from one, says when nothing matches and stays silent for no query", () => {
    expect(findCountText("room", 12, 2)).toBe("3 of 12");
    expect(findCountText("room", 1, 0)).toBe("1 of 1");
    expect(findCountText("zzz", 0, -1)).toBe("No matches");
    expect(findCountText("room", 12, -1)).toBe("12 matches");
    expect(findCountText("room", 1, -1)).toBe("1 match");
    expect(findCountText("room", 3, 3)).toBe("3 matches");
    expect(findCountText("  ", 0, -1)).toBe("");
    expect(findCountText("", 5, 0)).toBe("");
  });
});

describe("replacementOk", () => {
  it("wants a token with a letter or a number, like the backend", () => {
    expect(replacementOk("space")).toBe(true);
    expect(replacementOk("a 2")).toBe(true);
    expect(replacementOk("")).toBe(false);
    expect(replacementOk("   ")).toBe(false);
    expect(replacementOk("...")).toBe(false);
    expect(replacementOk("ok ...")).toBe(false);
  });
});
