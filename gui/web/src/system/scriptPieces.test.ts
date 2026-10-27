import { describe, expect, it } from "vitest";
import {
  CUT,
  cutMark,
  MUTED,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";
import {
  continuesSpeaker,
  linkCuts,
  pieceEnd,
  pieceStart,
  piecesOf,
  stopContaining,
  stopsOf,
  withEditing,
  wordLabel,
} from "./scriptPieces";

const [first, second, third] = SCRIPT_TURNS;

describe("piecesOf", () => {
  it("keeps plain words as one piece each", () => {
    const pieces = piecesOf(third.words, false);
    expect(pieces.map((piece) => piece.kind)).toEqual([
      "word",
      "word",
      "word",
      "word",
      "word",
    ]);
    expect(pieces.map(pieceStart)).toEqual([40, 41, 42, 43, 44]);
  });

  it("collapses a cut run into one pill with the length the host measured", () => {
    const [turn] = patchWords([first], spanPatch(1, 3, { mark: CUT }));
    const pieces = piecesOf(turn.words, false);
    expect(pieces[1]).toEqual({
      kind: "cut",
      id: "cut-1",
      start: 1,
      end: 3,
      removed: "1.1 s",
      words: "back to the",
    });
    expect(pieces).toHaveLength(18);
    expect(pieces.map(pieceStart).slice(0, 3)).toEqual([0, 1, 4]);
  });

  it("keeps two neighbouring cuts apart when their ids differ", () => {
    const [turn] = patchWords([first], {
      ...spanPatch(1, 2, { mark: cutMark("a", 0.5) }),
      ...spanPatch(3, 4, { mark: cutMark("b", 0.7) }),
    });
    const cuts = piecesOf(turn.words, false).filter((p) => p.kind === "cut");
    expect(
      cuts.map((c) => [
        c.kind === "cut" && c.id,
        c.kind === "cut" && c.removed,
      ]),
    ).toEqual([
      ["a", "0.5 s"],
      ["b", "0.7 s"],
    ]);
  });

  it("keeps two neighbouring suggestions apart when their ids differ", () => {
    const [turn] = patchWords([first], {
      ...spanPatch(6, 6, { mark: suggestedMark("s1") }),
      ...spanPatch(7, 7, { mark: suggestedMark("s2") }),
    });
    const runs = piecesOf(turn.words, false).filter(
      (p) => p.kind === "suggestion",
    );
    expect(runs.map((r) => r.kind === "suggestion" && [r.id, r.text])).toEqual([
      ["s1", "we"],
      ["s2", "are"],
    ]);
  });

  it("shows cut words as words when the text shows", () => {
    const [turn] = patchWords([first], spanPatch(1, 3, { mark: CUT }));
    const pieces = piecesOf(turn.words, true);
    expect(pieces).toHaveLength(20);
    expect(pieces[2]).toMatchObject({ kind: "word", word: { text: "to" } });
  });

  it("keeps a suggested run as one piece even when the cut text shows", () => {
    const [turn] = patchWords(
      [first],
      spanPatch(6, 7, { mark: suggestedMark("s1") }),
    );
    expect(piecesOf(turn.words, true)[6]).toEqual({
      kind: "suggestion",
      id: "s1",
      start: 6,
      end: 7,
      text: "we are",
    });
  });

  it("does not merge runs of different marks", () => {
    const [turn] = patchWords([first], {
      ...spanPatch(2, 3, { mark: CUT }),
      ...spanPatch(4, 5, { mark: suggestedMark("s1") }),
    });
    const kinds = piecesOf(turn.words, false)
      .slice(2, 4)
      .map((piece) => [piece.kind, pieceStart(piece), pieceEnd(piece)]);
    expect(kinds).toEqual([
      ["cut", 2, 3],
      ["suggestion", 4, 5],
    ]);
  });

  it("groups muted words and keeps each word inside", () => {
    const [turn] = patchWords([first], spanPatch(12, 14, { mark: MUTED }));
    const piece = piecesOf(turn.words, false)[12];
    expect(piece.kind).toBe("muted");
    expect([pieceStart(piece), pieceEnd(piece)]).toEqual([12, 14]);
    expect(piece.kind === "muted" && piece.words.map((w) => w.text)).toEqual([
      "small",
      "room",
      "can",
    ]);
  });
});

describe("linkCuts", () => {
  const byTurn = (marks: Parameters<typeof patchWords>[1]) => {
    const turns = patchWords(SCRIPT_TURNS, marks);
    return turns.map((turn) => piecesOf(turn.words, false));
  };
  const flags = (pieces: ReturnType<typeof piecesOf>[]) =>
    pieces.flat().flatMap((piece) =>
      piece.kind === "cut"
        ? [
            {
              id: piece.id,
              continued: piece.continued,
              continues: piece.continues,
            },
          ]
        : [],
    );

  it("marks a cut that crosses turns: the first continues, the rest are continued", () => {
    const linked = linkCuts(
      byTurn(spanPatch(18, 41, { mark: cutMark("x", 3) })),
    );
    expect(flags(linked)).toEqual([
      { id: "x", continued: undefined, continues: true },
      { id: "x", continued: true, continues: true },
      { id: "x", continued: true, continues: undefined },
    ]);
  });

  it("leaves a cut inside one turn, and the same pieces, alone", () => {
    const plain = byTurn(spanPatch(2, 3, { mark: cutMark("a", 0.7) }));
    const linked = linkCuts(plain);
    expect(flags(linked)).toEqual([
      { id: "a", continued: undefined, continues: undefined },
    ]);
    expect(linked[0]).toBe(plain[0]);
  });
});

describe("stopsOf", () => {
  it("makes one stop for a pill, one for a run and one for each muted word", () => {
    const [turn] = patchWords([third], {
      40: { mark: cutMark("c", 0.4) },
      41: { mark: cutMark("c", 0.4) },
      42: { mark: suggestedMark("s") },
      43: { mark: MUTED },
      44: { mark: MUTED },
    });
    expect(stopsOf(piecesOf(turn.words, false))).toEqual([
      { kind: "cut", start: 40, end: 41, id: "c" },
      { kind: "suggestion", start: 42, end: 42, id: "s" },
      { kind: "word", start: 43, end: 43 },
      { kind: "word", start: 44, end: 44 },
    ]);
  });

  it("finds the stop that holds a word inside a pill", () => {
    const [turn] = patchWords([third], spanPatch(41, 43, { mark: CUT }));
    const stops = stopsOf(piecesOf(turn.words, false));
    expect(stopContaining(stops, 42)).toEqual({
      kind: "cut",
      start: 41,
      end: 43,
      id: "cut-1",
    });
    expect(stopContaining(stops, 99)).toBeUndefined();
  });
});

describe("withEditing", () => {
  it("swaps the words under the field for one slot and drops it from the stops", () => {
    const pieces = piecesOf(third.words, false);
    const editing = withEditing(pieces, { start: 41, end: 42 });
    expect(editing.map((p) => p.kind)).toEqual([
      "word",
      "editing",
      "word",
      "word",
    ]);
    expect(editing[1]).toEqual({ kind: "editing", start: 41, end: 42 });
    expect(stopsOf(editing).map((stop) => stop.start)).toEqual([40, 43, 44]);
  });

  it("returns the same pieces when nothing is edited or the span is elsewhere", () => {
    const pieces = piecesOf(third.words, false);
    expect(withEditing(pieces, null)).toBe(pieces);
    expect(withEditing(pieces, { start: 90, end: 91 })).toBe(pieces);
  });
});

describe("continuesSpeaker", () => {
  it("merges the same speaker after a gap under two seconds", () => {
    expect(continuesSpeaker(third, second)).toBe(true);
  });

  it("names a different speaker, a long gap and a missing gap", () => {
    expect(continuesSpeaker(second, first)).toBe(false);
    expect(continuesSpeaker({ ...third, pauseBefore: 2 }, second)).toBe(false);
    expect(continuesSpeaker({ ...third, pauseBefore: undefined }, second)).toBe(
      false,
    );
    expect(continuesSpeaker(first, undefined)).toBe(false);
  });

  it("goes by speaker id, not by name", () => {
    expect(
      continuesSpeaker(
        { ...third, speaker: { name: "Maya Okafor", colorIndex: 4 } },
        second,
      ),
    ).toBe(true);
    expect(continuesSpeaker({ ...third, speakerId: "other" }, second)).toBe(
      false,
    );
  });
});

describe("wordLabel", () => {
  const plain = { index: 0, text: "word" };
  const off = { selected: false };
  it("leaves a plain word to its text", () => {
    expect(wordLabel(plain, off)).toBeUndefined();
  });

  it("names every state the eye reads from style", () => {
    expect(wordLabel({ ...plain, mark: CUT }, off)).toBe("word (cut)");
    expect(wordLabel({ ...plain, mark: MUTED }, off)).toBe("word (muted)");
    expect(
      wordLabel(
        { ...plain, lowConfidence: true, restored: true },
        { selected: true, found: "current" },
      ),
    ).toBe("word (unsure, restored, current match, selected)");
    expect(wordLabel(plain, { selected: false, found: "match" })).toBe(
      "word (match)",
    );
  });
});
