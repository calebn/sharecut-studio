import { describe, expect, it } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import type {
  FindHit,
  ScriptTurn,
  ScriptWord,
} from "../../system/scriptPieces";
import {
  findCountText,
  findMatches,
  replacementChanges,
  replacementOk,
} from "./findMatches";

const side = (
  key: string,
  index: number,
  text: string,
  mark?: ScriptWord["mark"],
): ScriptTurn => ({
  ...SCRIPT_TURNS[0],
  words: [{ index, key, text, ...(mark ? { mark } : {}) }],
});

describe("findMatches", () => {
  it("finds a word in every turn as a span of its index", () => {
    expect(findMatches(SCRIPT_TURNS, "room", false)).toEqual([
      { indices: [13] },
      { indices: [32] },
    ]);
  });

  it("covers every word a phrase touches", () => {
    expect(findMatches(SCRIPT_TURNS, "small room", false)).toEqual([
      { indices: [12, 13] },
    ]);
    expect(findMatches(SCRIPT_TURNS, "found the microphones", false)).toEqual([
      { indices: [37, 38, 39] },
    ]);
  });

  it("matches whole words only, like the backend", () => {
    expect(findMatches(SCRIPT_TURNS, "icroph", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "micro", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "the", false)).toEqual([
      { indices: [3] },
      { indices: [24] },
      { indices: [31] },
      { indices: [38] },
    ]);
  });

  it("strips punctuation at the edges of the query and of each word", () => {
    expect(findMatches(SCRIPT_TURNS, "show", false)).toEqual([
      { indices: [4] },
    ]);
    expect(findMatches(SCRIPT_TURNS, "(show!)", false)).toEqual([
      { indices: [4] },
    ]);
    expect(findMatches(SCRIPT_TURNS, "...", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "so um", false)).toEqual([
      { indices: [45, 46] },
    ]);
    expect(findMatches(SCRIPT_TURNS, "so you", false)).toEqual([]);
  });

  it("matches a phrase that ends one turn and starts the next, as the backend does", () => {
    const hits = findMatches(SCRIPT_TURNS, "one. Thanks", false);
    expect(hits).toHaveLength(1);
    expect(hits[0].indices).toHaveLength(2);
    const turnOf = (index: number) =>
      SCRIPT_TURNS.findIndex((turn) =>
        turn.words.some((word) => word.index === index),
      );
    expect(turnOf(hits[0].indices[1])).toBe(turnOf(hits[0].indices[0]) + 1);
  });

  it("never matches a phrase across two transcripts", () => {
    const turns = [side("host:a:7", 0, "one"), side("guest:b:0", 1, "thanks")];
    expect(findMatches(turns, "one thanks", false)).toEqual([]);
    const sources = [side("host:a:7", 0, "one"), side("host:b:0", 1, "thanks")];
    expect(findMatches(sources, "one thanks", false)).toEqual([]);
    const same = [side("host:a:7", 0, "one"), side("host:a:8", 1, "thanks")];
    expect(findMatches(same, "one thanks", false)).toEqual([
      { indices: [0, 1] },
    ]);
  });

  describe("a phrase another transcript interrupts", () => {
    const abaTurns = [
      side("host:a:0", 0, "one"),
      side("guest:b:0", 1, "yes"),
      side("host:a:1", 2, "thanks"),
    ];

    it("finds A, B, A as the hit of A's own words", () => {
      expect(findMatches(abaTurns, "one thanks", false)).toEqual([
        { indices: [0, 2] },
      ]);
    });

    it("does not find a phrase through the interrupting word", () => {
      expect(findMatches(abaTurns, "one yes", false)).toEqual([]);
      expect(findMatches(abaTurns, "yes", false)).toEqual([{ indices: [1] }]);
    });

    it("finds each interrupted phrase of A, B, A, B, A, B, A in order", () => {
      const turns = [
        side("host:a:0", 0, "one"),
        side("guest:b:0", 1, "x"),
        side("host:a:1", 2, "thanks"),
        side("guest:b:1", 3, "x"),
        side("host:a:2", 4, "one"),
        side("guest:b:2", 5, "x"),
        side("host:a:3", 6, "thanks"),
      ];
      expect(findMatches(turns, "one thanks", false)).toEqual([
        { indices: [0, 2] },
        { indices: [4, 6] },
      ]);
    });

    it("finds a phrase in each of two interleaved transcripts", () => {
      const turns = [
        side("host:a:0", 0, "one"),
        side("guest:b:0", 1, "one"),
        side("host:a:1", 2, "thanks"),
        side("guest:b:1", 3, "thanks"),
      ];
      expect(findMatches(turns, "one thanks", false)).toEqual([
        { indices: [0, 2] },
        { indices: [1, 3] },
      ]);
    });

    it("breaks a phrase on its own transcript's muted word, not on another's", () => {
      const muted: NonNullable<ScriptWord["mark"]> = { kind: "muted" };
      expect(
        findMatches(
          [
            side("host:a:0", 0, "one"),
            side("guest:b:0", 1, "x"),
            side("host:a:1", 2, "thanks", muted),
            side("host:a:2", 3, "thanks"),
          ],
          "one thanks",
          false,
        ),
      ).toEqual([]);
      expect(
        findMatches(
          [
            side("host:a:0", 0, "one"),
            side("guest:b:0", 1, "x", muted),
            side("host:a:1", 2, "thanks"),
          ],
          "one thanks",
          false,
        ),
      ).toEqual([{ indices: [0, 2] }]);
    });

    it("replaces an interrupted hit by its own words only", () => {
      const hit: FindHit[] = [{ indices: [0, 2] }];
      expect(replacementChanges(abaTurns, hit, "one thanks")).toEqual([]);
      expect(replacementChanges(abaTurns, hit, "two thanks")).toEqual([
        { indices: [0, 2] },
      ]);
    });
  });

  it("matches case only when asked", () => {
    expect(findMatches(SCRIPT_TURNS, "WELCOME", false)).toEqual([
      { indices: [0] },
    ]);
    expect(findMatches(SCRIPT_TURNS, "WELCOME", true)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "Welcome", true)).toEqual([
      { indices: [0] },
    ]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findMatches(SCRIPT_TURNS, "", false)).toEqual([]);
    expect(findMatches(SCRIPT_TURNS, "   ", false)).toEqual([]);
  });

  it("ignores spaces around the query and between its words", () => {
    expect(findMatches(SCRIPT_TURNS, "  small   room ", false)).toEqual([
      { indices: [12, 13] },
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
    expect(findMatches([turn], "a", false)).toEqual([{ indices: [2] }]);
    expect(findMatches([turn], "a b", false)).toEqual([{ indices: [2, 3] }]);
    expect(findMatches([turn], "STRASSE", false)).toEqual([{ indices: [4] }]);
    expect(findMatches([turn], "STRASSE", true)).toEqual([]);
    expect(findMatches([turn], "\u0130", false)).toEqual([
      { indices: [0] },
      { indices: [1] },
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
      { indices: [3] },
      { indices: [5] },
    ]);
    expect(findMatches([turn], "so um", false)).toEqual([{ indices: [4, 5] }]);
  });

  it("finds hits on a long turn in well under a second", () => {
    const words = Array.from({ length: 50_000 }, (_, index) => ({
      index,
      text: "a",
    }));
    const turn: ScriptTurn = { ...SCRIPT_TURNS[0], words };
    const before = performance.now();
    const spans = findMatches([turn], "a", false);
    expect(spans).toHaveLength(50_000);
    expect(performance.now() - before).toBeLessThan(2000);
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

describe("replacementChanges", () => {
  const turn = (texts: string[]): ScriptTurn => ({
    ...SCRIPT_TURNS[0],
    words: texts.map((text, index) => ({ index, text })),
  });
  const hits = (turns: ScriptTurn[], query: string, matchCase = false) =>
    findMatches(turns, query, matchCase);

  it("drops a hit whose replacement is the very words already there", () => {
    const turns = [turn(["Room", "room.", "ROOM", "a", "room,"])];
    const all = hits(turns, "room");
    expect(all).toEqual([
      { indices: [0] },
      { indices: [1] },
      { indices: [2] },
      { indices: [4] },
    ]);
    expect(replacementChanges(turns, all, "Room")).toEqual([
      { indices: [1] },
      { indices: [2] },
      { indices: [4] },
    ]);
    expect(replacementChanges(turns, all, "room")).toEqual([
      { indices: [0] },
      { indices: [2] },
    ]);
    expect(replacementChanges(turns, all, "space")).toEqual(all);
  });

  it("keeps the old edge punctuation unless the replacement brings its own", () => {
    const turns = [turn(["(room),", "x"])];
    const all = hits(turns, "room");
    expect(replacementChanges(turns, all, "room")).toEqual([]);
    expect(replacementChanges(turns, all, "room.")).toEqual(all);
    expect(replacementChanges(turns, all, "(room)")).toEqual(all);
    expect(replacementChanges(turns, all, "room,")).toEqual(all);
  });

  it("compares phrases word by word, and a different number of words is a change", () => {
    const turns = [turn(["small", "room", "Small", "room."])];
    const all = hits(turns, "small room");
    expect(all).toEqual([{ indices: [0, 1] }, { indices: [2, 3] }]);
    expect(replacementChanges(turns, all, "small room")).toEqual([
      { indices: [2, 3] },
    ]);
    expect(replacementChanges(turns, all, "Small room")).toEqual([
      { indices: [0, 1] },
    ]);
    expect(replacementChanges(turns, all, "small")).toEqual(all);
  });

  it("changes nothing when the backend would refuse the replacement", () => {
    const turns = [turn(["room"])];
    const all = hits(turns, "room");
    expect(replacementChanges(turns, all, "")).toEqual([]);
    expect(replacementChanges(turns, all, "...")).toEqual([]);
  });
});
