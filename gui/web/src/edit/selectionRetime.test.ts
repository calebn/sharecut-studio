import { describe, expect, it } from "vitest";
import type { SelectionModel } from "./selectionFollow";
import { retimedInPlace } from "./selectionRetime";

type Word = {
  text: string;
  start: number;
  track?: string;
  source?: string | null;
  cut?: boolean;
  index?: number;
};

function model(words: Word[]): SelectionModel {
  return {
    turns: [],
    spans: [],
    refs: words.map((w, at) => ({
      trackId: w.track ?? "a",
      sourceId: w.source ?? null,
      wordIndex: w.index ?? at,
    })),
    times: words.map(() => null),
    wordStarts: words.map((w) => w.start),
    words: words.map((w) => ({ start: w.start, text: w.text })),
    cut: words.map((w) => w.cut ?? false),
  };
}

const BASE: Word[] = [
  { text: "a", start: 0 },
  { text: "b", start: 1 },
  { text: "c", start: 2 },
  { text: "d", start: 3 },
];

function edited(over: Record<number, Partial<Word>>): SelectionModel {
  return model(BASE.map((w, at) => ({ ...w, ...over[at] })));
}

describe("retimedInPlace", () => {
  const before = model(BASE);

  it("is true when a word in the run moved its start", () => {
    expect(retimedInPlace(before, edited({ 1: { start: 1.2 } }), 1, 2)).toBe(
      true,
    );
  });

  it("is true when the run is one word at the edge of the model", () => {
    expect(retimedInPlace(before, edited({ 3: { start: 3.4 } }), 3, 3)).toBe(
      true,
    );
    expect(retimedInPlace(before, edited({ 0: { start: 0.4 } }), 0, 0)).toBe(
      true,
    );
  });

  it("is false when nothing moved", () => {
    expect(retimedInPlace(before, edited({}), 1, 2)).toBe(false);
  });

  it("is false when a start moved by less than a rounding step", () => {
    expect(
      retimedInPlace(before, edited({ 1: { start: 1 + 1e-9 } }), 1, 2),
    ).toBe(false);
  });

  it("is false when the word count differs", () => {
    expect(retimedInPlace(before, model(BASE.slice(0, 3)), 1, 2)).toBe(false);
  });

  it("is false when the run lies outside the model", () => {
    const next = edited({ 1: { start: 1.2 } });
    expect(retimedInPlace(before, next, -1, 1)).toBe(false);
    expect(retimedInPlace(before, next, 2, 1)).toBe(false);
    expect(retimedInPlace(before, next, 1, 4)).toBe(false);
  });

  it.each([
    ["text", { text: "x" }],
    ["track", { track: "b" }],
    ["recording", { source: "s2" }],
    ["number", { index: 9 }],
    ["cut state", { cut: true }],
  ])("is false when a retimed word also changes its %s", (_what, over) => {
    expect(
      retimedInPlace(before, edited({ 1: { start: 1.2, ...over } }), 1, 2),
    ).toBe(false);
  });

  it("is false when a word outside the run moved, before or after", () => {
    expect(
      retimedInPlace(
        before,
        edited({ 1: { start: 1.2 }, 0: { start: 0.2 } }),
        1,
        2,
      ),
    ).toBe(false);
    expect(
      retimedInPlace(
        before,
        edited({ 1: { start: 1.2 }, 3: { start: 3.2 } }),
        1,
        2,
      ),
    ).toBe(false);
  });

  it("is false when a word outside the run changed text", () => {
    expect(
      retimedInPlace(
        before,
        edited({ 1: { start: 1.2 }, 3: { text: "x" } }),
        1,
        2,
      ),
    ).toBe(false);
  });

  it("is false when a start is not a number", () => {
    expect(
      retimedInPlace(before, edited({ 1: { start: Number.NaN } }), 1, 2),
    ).toBe(false);
  });

  describe("with an equal-text word of the same recording", () => {
    const twin = (start: number, over: Partial<Word> = {}): Word[] => [
      { text: "a", start: 0 },
      { text: "b", start: 1 },
      { text: "b", start, ...over },
    ];

    it("is false when the twin sits nearer the old start than the new one", () => {
      const was = model(twin(2));
      const now = model([
        { text: "a", start: 0 },
        { text: "b", start: 5 },
        { text: "b", start: 2 },
      ]);
      expect(retimedInPlace(was, now, 1, 1)).toBe(false);
    });

    it("is true when the retimed word stays nearer its old start", () => {
      const was = model(twin(9));
      const now = model([
        { text: "a", start: 0 },
        { text: "b", start: 1.5 },
        { text: "b", start: 9 },
      ]);
      expect(retimedInPlace(was, now, 1, 1)).toBe(true);
    });

    it("is true when the twin is exactly as far from the old start as the new one", () => {
      const was = model([
        { text: "b", start: 1 },
        { text: "b", start: -1 },
      ]);
      const now = model([
        { text: "b", start: 3 },
        { text: "b", start: -1 },
      ]);
      expect(retimedInPlace(was, now, 0, 0)).toBe(true);
    });

    it("ignores a twin that is cut", () => {
      const was = model(twin(2, { cut: true }));
      const now = model([
        { text: "a", start: 0 },
        { text: "b", start: 5 },
        { text: "b", start: 2, cut: true },
      ]);
      expect(retimedInPlace(was, now, 1, 1)).toBe(true);
    });

    it("ignores a twin on another track or recording", () => {
      for (const over of [{ track: "b" }, { source: "s2" }]) {
        const was = model(twin(2, over));
        const now = model([
          { text: "a", start: 0 },
          { text: "b", start: 5 },
          { text: "b", start: 2, ...over },
        ]);
        expect(retimedInPlace(was, now, 1, 1)).toBe(true);
      }
    });

    it("ignores a word with other text near the old start", () => {
      const was = model([
        { text: "a", start: 0 },
        { text: "b", start: 1 },
        { text: "c", start: 2 },
      ]);
      const now = model([
        { text: "a", start: 0 },
        { text: "b", start: 5 },
        { text: "c", start: 2 },
      ]);
      expect(retimedInPlace(was, now, 1, 1)).toBe(true);
    });
  });
});
