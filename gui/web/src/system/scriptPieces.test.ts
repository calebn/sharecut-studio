import { describe, expect, it } from "vitest";
import { patchWords, SCRIPT_TURNS, spanPatch } from "./scriptFixtures";
import {
  continuesSpeaker,
  pieceEnd,
  pieceStart,
  piecesOf,
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

  it("collapses a cut run into one pill with its length and words", () => {
    const [turn] = patchWords([first], spanPatch(1, 3, { state: "cut" }));
    const pieces = piecesOf(turn.words, false);
    expect(pieces[1]).toEqual({
      kind: "cut",
      start: 1,
      end: 3,
      removed: "0.9 s",
      words: "back to the",
    });
    expect(pieces).toHaveLength(18);
    expect(pieces.map(pieceStart).slice(0, 3)).toEqual([0, 1, 4]);
  });

  it("shows cut words as words when the text shows", () => {
    const [turn] = patchWords([first], spanPatch(1, 3, { state: "cut" }));
    const pieces = piecesOf(turn.words, true);
    expect(pieces).toHaveLength(20);
    expect(pieces[2]).toMatchObject({ kind: "word", word: { text: "to" } });
  });

  it("keeps a suggested run as one piece even when the cut text shows", () => {
    const [turn] = patchWords([first], spanPatch(6, 7, { state: "suggested" }));
    const pieces = piecesOf(turn.words, true);
    expect(pieces[6]).toEqual({
      kind: "suggestion",
      start: 6,
      end: 7,
      text: "we are",
    });
  });

  it("does not merge runs of different states", () => {
    const [turn] = patchWords([first], {
      ...spanPatch(2, 3, { state: "cut" }),
      ...spanPatch(4, 5, { state: "suggested" }),
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
    const [turn] = patchWords([first], spanPatch(12, 14, { state: "muted" }));
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
});
