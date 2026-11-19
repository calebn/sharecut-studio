import { describe, expect, it } from "vitest";
import {
  followSelection,
  type RememberedSelection,
  type SelectionModel,
  selectionEndOf,
} from "./selectionFollow";

type Spec = {
  trackId?: string;
  sourceId?: string | null;
  wordIndex?: number | null;
  start: number;
  text?: string;
  time?: { start: number; end: number } | null;
  held?: boolean;
  cut?: boolean;
};

function modelOf(
  specs: readonly Spec[],
  extra: Partial<SelectionModel> = {},
): SelectionModel {
  return {
    turns: [{ words: specs.map((_, index) => ({ index })) }],
    spans: [],
    refs: specs.map((s, i) => ({
      trackId: s.trackId ?? "a",
      sourceId: s.sourceId ?? null,
      wordIndex: s.wordIndex === undefined ? i : s.wordIndex,
    })),
    words: specs.map((s) => ({ start: s.start, text: s.text ?? "hello" })),
    times: specs.map((s) =>
      s.time === undefined ? { start: s.start, end: s.start + 1 } : s.time,
    ),
    wordStarts: specs.map((s) => (s.held || s.cut ? null : s.start)),
    cut: specs.map((s) => s.cut === true),
    ...extra,
  };
}

function remember(
  model: SelectionModel,
  anchor: number,
  head = anchor,
): RememberedSelection {
  return {
    stored: {},
    anchor: selectionEndOf(model, anchor)!,
    head: selectionEndOf(model, head)!,
  };
}

const ONE: Spec = { start: 1 };

describe("following a selection across two Script models", () => {
  it("keeps a word that is exactly where it was", () => {
    const before = modelOf([ONE]);
    expect(followSelection(remember(before, 0), modelOf([ONE]))).toEqual({
      kind: "keep",
    });
  });

  it("clears when the word's text changed at the same start", () => {
    const before = modelOf([ONE]);
    expect(
      followSelection(
        remember(before, 0),
        modelOf([{ ...ONE, text: "other" }]),
      ),
    ).toEqual({ kind: "clear" });
  });

  it("clears when the word now sits in another recording", () => {
    const before = modelOf([ONE]);
    expect(
      followSelection(
        remember(before, 0),
        modelOf([{ ...ONE, sourceId: "s2" }]),
      ),
    ).toEqual({ kind: "clear" });
  });

  it("clears when the same word is only on another track", () => {
    const before = modelOf([ONE]);
    expect(
      followSelection(remember(before, 0), modelOf([{ ...ONE, trackId: "b" }])),
    ).toEqual({ kind: "clear" });
  });

  it("clears when the word's source start moved", () => {
    const before = modelOf([ONE]);
    expect(
      followSelection(remember(before, 0), modelOf([{ ...ONE, start: 1.5 }])),
    ).toEqual({ kind: "clear" });
  });

  it("moves to the new numbers when the word was renumbered", () => {
    const before = modelOf([ONE]);
    const after = modelOf([{ start: 0, text: "x" }, ONE]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "move",
      anchor: 1,
      head: 1,
    });
  });

  it("moves when only the word_index changed and the timeline place did not", () => {
    const before = modelOf([{ ...ONE, wordIndex: 3 }]);
    const after = modelOf([{ ...ONE, wordIndex: 4 }]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "move",
      anchor: 0,
      head: 0,
    });
  });

  it("moves when only the timeline place changed and the word_index did not", () => {
    const before = modelOf([{ ...ONE, time: { start: 1, end: 2 } }]);
    const after = modelOf([{ ...ONE, time: { start: 5, end: 6 } }]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "move",
      anchor: 0,
      head: 0,
    });
  });

  it("keeps a word whose timeline place differs only within rounding", () => {
    const before = modelOf([{ ...ONE, time: { start: 1, end: 2 } }]);
    const after = modelOf([{ ...ONE, time: { start: 1 + 1e-9, end: 2 } }]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "keep",
    });
  });

  it("clears when the word is now one an applied cut took out", () => {
    const before = modelOf([ONE]);
    const after = modelOf([{ ...ONE, cut: true, time: null }]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "clear",
    });
  });

  it("clears when the word is gone altogether", () => {
    const before = modelOf([ONE]);
    expect(followSelection(remember(before, 0), modelOf([]))).toEqual({
      kind: "clear",
    });
  });

  it("clears when either end is gone, even if the other waits", () => {
    const before = modelOf([ONE, { start: 2 }]);
    const after = modelOf([{ start: 2, held: true }]);
    expect(followSelection(remember(before, 1, 0), after)).toEqual({
      kind: "clear",
    });
  });
});

describe("waiting for words that are not live yet", () => {
  it("waits while the word is held", () => {
    const before = modelOf([ONE]);
    expect(
      followSelection(remember(before, 0), modelOf([{ ...ONE, held: true }])),
    ).toEqual({ kind: "wait" });
  });

  it("waits while the word's line is drawn as bars", () => {
    const before = modelOf([ONE]);
    const after = modelOf([], {
      turns: [{ words: [] }],
      spans: [{ trackId: "a", sourceId: null, start: 0, end: 10 }],
    });
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "wait",
    });
  });

  it("does not wait for a bar line over another recording", () => {
    const before = modelOf([ONE]);
    const after = modelOf([ONE], {
      turns: [{ words: [{ index: 0 }] }, { words: [] }],
      spans: [
        { trackId: "a", sourceId: null, start: 5, end: 6 },
        { trackId: "a", sourceId: "s2", start: 0, end: 10 },
      ],
    });
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "keep",
    });
  });

  it("does not wait for a bar line over another track", () => {
    const before = modelOf([ONE]);
    const after = modelOf([ONE], {
      turns: [{ words: [{ index: 0 }] }, { words: [] }],
      spans: [
        { trackId: "a", sourceId: null, start: 5, end: 6 },
        { trackId: "b", sourceId: null, start: 0, end: 10 },
      ],
    });
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "keep",
    });
  });

  it("does not wait for a bar line that ends before the word", () => {
    const before = modelOf([ONE]);
    const after = modelOf([ONE], {
      turns: [{ words: [{ index: 0 }] }, { words: [] }],
      spans: [
        { trackId: "a", sourceId: null, start: 5, end: 6 },
        { trackId: "a", sourceId: null, start: 2, end: 3 },
      ],
    });
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "keep",
    });
  });
});

describe("a word that exists as several copies", () => {
  const COPY_A: Spec = { start: 1, wordIndex: 3, time: { start: 1, end: 2 } };
  const COPY_B: Spec = { start: 1, wordIndex: 9, time: { start: 7, end: 8 } };

  it("counts the copies when it is remembered", () => {
    expect(selectionEndOf(modelOf([COPY_A, COPY_B]), 0)!.copies).toBe(2);
    expect(selectionEndOf(modelOf([COPY_A]), 0)!.copies).toBe(1);
  });

  it("clears when only another copy is left than the one picked", () => {
    const before = modelOf([COPY_A, COPY_B]);
    expect(followSelection(remember(before, 0), modelOf([COPY_B]))).toEqual({
      kind: "clear",
    });
  });

  it("keeps the picked copy when both are still there", () => {
    const before = modelOf([COPY_A, COPY_B]);
    expect(
      followSelection(remember(before, 1), modelOf([COPY_A, COPY_B])),
    ).toEqual({ kind: "keep" });
  });

  it("follows the picked copy when its neighbour copy is cut", () => {
    const before = modelOf([COPY_A, COPY_B]);
    const after = modelOf([COPY_A, { ...COPY_B, cut: true, time: null }]);
    expect(followSelection(remember(before, 0), after)).toEqual({
      kind: "keep",
    });
  });
});
