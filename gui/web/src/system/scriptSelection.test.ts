import { describe, expect, it } from "vitest";
import type { ScriptPiece, ScriptStop } from "./scriptPieces";
import {
  extendTo,
  navigate,
  selectionSummary,
  spanOf,
} from "./scriptSelection";

// word 0, word 1, a cut pill over 2 to 4, word 5, a run over 6 to 7, word 8.
const stops: ScriptStop[] = [
  { kind: "word", start: 0, end: 0 },
  { kind: "word", start: 1, end: 1 },
  { kind: "cut", start: 2, end: 4, id: "c" },
  { kind: "word", start: 5, end: 5 },
  { kind: "suggestion", start: 6, end: 7, id: "s" },
  { kind: "word", start: 8, end: 8 },
];
const words = (anchor: number, head: number) =>
  ({ kind: "words", anchor, head }) as const;

describe("navigate without Shift", () => {
  it("moves the caret to the start of the place it reaches", () => {
    expect(navigate(stops, 1, "ArrowRight", false, null)).toEqual({
      to: 2,
      caret: 2,
    });
    expect(navigate(stops, 3, "ArrowLeft", false, null)).toEqual({
      to: 2,
      caret: 2,
    });
    expect(navigate(stops, 3, "Home", false, null)).toEqual({
      to: 0,
      caret: 0,
    });
    expect(navigate(stops, 3, "End", false, null)).toEqual({ to: 5, caret: 8 });
  });

  it("reports nothing at the ends", () => {
    expect(navigate(stops, 5, "ArrowRight", false, null)).toBeNull();
    expect(navigate(stops, 0, "ArrowLeft", false, null)).toBeNull();
    expect(navigate(stops, 0, "Home", false, null)).toBeNull();
  });

  it("reports nothing without stops", () => {
    expect(navigate([], 0, "ArrowRight", false, null)).toBeNull();
  });
});

describe("navigate with Shift", () => {
  it("starts from the place the move began", () => {
    expect(navigate(stops, 0, "ArrowRight", true, null)).toEqual({
      to: 1,
      selection: words(0, 1),
    });
    expect(navigate(stops, 1, "ArrowLeft", true, null)).toEqual({
      to: 0,
      selection: words(1, 0),
    });
  });

  it("takes the far edge of a pill in the direction of travel", () => {
    expect(navigate(stops, 1, "ArrowRight", true, words(1, 1))).toEqual({
      to: 2,
      selection: words(1, 4),
    });
    expect(navigate(stops, 3, "ArrowLeft", true, words(5, 5))).toEqual({
      to: 2,
      selection: words(5, 2),
    });
  });

  it("takes the whole run of a suggestion going right", () => {
    expect(navigate(stops, 3, "ArrowRight", true, words(5, 5))).toEqual({
      to: 4,
      selection: words(5, 7),
    });
  });

  it("starts from the near edge of a pill it leaves", () => {
    expect(navigate(stops, 2, "ArrowRight", true, null)).toEqual({
      to: 3,
      selection: words(2, 5),
    });
    expect(navigate(stops, 2, "ArrowLeft", true, null)).toEqual({
      to: 1,
      selection: words(4, 1),
    });
  });

  it("shrinks when the head comes back instead of flipping", () => {
    expect(navigate(stops, 3, "ArrowLeft", true, words(1, 5))).toEqual({
      to: 2,
      selection: words(1, 4),
    });
    expect(navigate(stops, 2, "ArrowLeft", true, words(1, 4))).toEqual({
      to: 1,
      selection: words(1, 1),
    });
  });

  it("extends to the ends with Home and End", () => {
    expect(navigate(stops, 3, "End", true, words(3, 3))).toEqual({
      to: 5,
      selection: words(3, 8),
    });
    expect(navigate(stops, 3, "Home", true, null)).toEqual({
      to: 0,
      selection: words(5, 0),
    });
  });

  it("starts again from the focus when a cut is selected", () => {
    expect(
      navigate(stops, 3, "ArrowRight", true, { kind: "cut", id: "c" }),
    ).toEqual({ to: 4, selection: words(5, 7) });
  });

  it("reports nothing when the selection would stay as it is", () => {
    expect(navigate(stops, 5, "ArrowRight", true, words(3, 8))).toBeNull();
  });
});

describe("extendTo", () => {
  it("keeps the anchor and lands the head on the edge of what it reached", () => {
    expect(extendTo(5, { start: 2, end: 4 })).toEqual(words(5, 2));
    expect(extendTo(1, { start: 2, end: 4 })).toEqual(words(1, 4));
    expect(extendTo(3, { start: 2, end: 4 })).toEqual(words(3, 3));
  });
});

describe("spanOf", () => {
  it("orders the anchor and head and ignores a cut", () => {
    expect(spanOf(words(7, 3))).toEqual({ start: 3, end: 7 });
    expect(spanOf({ kind: "cut", id: "c" })).toBeNull();
    expect(spanOf(null)).toBeNull();
  });
});

describe("selectionSummary", () => {
  const word = (index: number, text: string): ScriptPiece => ({
    kind: "word",
    word: { index, text },
  });
  const pieces: ScriptPiece[] = [
    word(0, "a"),
    word(1, "b"),
    {
      kind: "cut",
      id: "c",
      start: 2,
      end: 3,
      removed: "1.1 s",
      words: "x y",
    },
    { kind: "suggestion", id: "s", start: 4, end: 4, text: "um" },
    {
      kind: "muted",
      words: [
        { index: 5, text: "m1" },
        { index: 6, text: "m2" },
      ],
    },
    ...Array.from({ length: 20 }, (_, at) => word(7 + at, `w${7 + at}`)),
  ];

  it("reads a range with its pill, run and muted words in order", () => {
    expect(selectionSummary(pieces, words(1, 5))).toBe(
      "5 words selected: b cut x y um m1",
    );
  });

  it("reads a single word, a cut and a suggestion", () => {
    expect(selectionSummary(pieces, words(0, 0))).toBe("1 word selected: a");
    expect(selectionSummary(pieces, { kind: "cut", id: "c" })).toBe(
      "Cut selected, 1.1 s removed",
    );
    expect(selectionSummary(pieces, { kind: "suggestion", id: "s" })).toBe(
      "Suggested cut selected: um",
    );
  });

  it("cuts a long range short and says nothing for no selection", () => {
    expect(selectionSummary(pieces, words(7, 26))).toBe(
      "20 words selected: w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 ...",
    );
    expect(selectionSummary(pieces, null)).toBe("");
  });
});
