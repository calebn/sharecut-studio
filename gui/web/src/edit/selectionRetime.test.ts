import { describe, expect, it } from "vitest";
import { type SelectionModel, selectionEndOf } from "./selectionFollow";
import { retimedInPlace, retimeKeeps } from "./selectionRetime";

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

  it("is false when a word was added after the run", () => {
    const longer = model([...BASE, { text: "e", start: 4 }]);
    expect(retimedInPlace(before, longer, 1, 2)).toBe(false);
  });

  it("is false when the run lies outside the model", () => {
    const next = edited({ 1: { start: 1.2 } });
    expect(retimedInPlace(before, next, -1, 1)).toBe(false);
    expect(retimedInPlace(before, next, 2, 1)).toBe(false);
    expect(retimedInPlace(before, next, 1, 4)).toBe(false);
  });

  it.each([
    ["track", { track: "b" }],
    ["recording", { source: "s2" }],
    ["number", { index: 9 }],
    ["cut state", { cut: true }],
  ])("is false when a retimed word also changes its %s", (_what, over) => {
    expect(
      retimedInPlace(before, edited({ 1: { start: 1.2, ...over } }), 1, 2),
    ).toBe(false);
  });

  it.each([
    ["first", 1],
    ["last", 2],
  ])(
    "is true when only the text of the %s word of the run differs",
    (_end, at) => {
      expect(
        retimedInPlace(before, edited({ [at]: { text: "x" } }), 1, 2),
      ).toBe(true);
    },
  );

  it("is true when only the text of a middle word of the run differs", () => {
    expect(retimedInPlace(before, edited({ 2: { text: "x" } }), 1, 3)).toBe(
      true,
    );
  });

  it("is true when the one word of the run differs only in text", () => {
    expect(retimedInPlace(before, edited({ 3: { text: "x" } }), 3, 3)).toBe(
      true,
    );
  });

  it("is true when one word is retimed and respelled together", () => {
    expect(
      retimedInPlace(before, edited({ 1: { start: 1.2, text: "x" } }), 1, 2),
    ).toBe(true);
  });

  it("is true when one word is retimed and another respelled", () => {
    expect(
      retimedInPlace(
        before,
        edited({ 1: { start: 1.2 }, 2: { text: "x" } }),
        1,
        2,
      ),
    ).toBe(true);
  });

  it.each([
    ["track", { track: "b" }],
    ["recording", { source: "s2" }],
    ["number", { index: 9 }],
    ["cut state", { cut: true }],
  ])("is false when a respelled word also changes its %s", (_what, over) => {
    expect(
      retimedInPlace(before, edited({ 1: { text: "x", ...over } }), 1, 2),
    ).toBe(false);
  });

  it("is false when a respelled run comes with a word count change", () => {
    const merged = model([
      { text: "a", start: 0 },
      { text: "x", start: 1 },
      { text: "d", start: 3 },
    ]);
    expect(retimedInPlace(before, merged, 1, 2)).toBe(false);
  });

  it("is false when a word before the run is respelled and none in it changed", () => {
    expect(retimedInPlace(before, edited({ 0: { text: "x" } }), 1, 2)).toBe(
      false,
    );
  });

  it("is true when a respelled word takes the text of another word in the recording", () => {
    expect(retimedInPlace(before, edited({ 1: { text: "d" } }), 1, 2)).toBe(
      true,
    );
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

  it("is true when only the timeline place of a word outside the run changed", () => {
    const next = edited({ 1: { start: 1.2 } });
    const timed = (shift: number): SelectionModel => ({
      ...next,
      times: next.times.map((_, at) => ({ start: at + shift, end: at + 1 })),
    });
    const was = { ...before, times: timed(0).times };
    expect(retimedInPlace(was, timed(0.5), 1, 2)).toBe(true);
  });

  it("is false when a start outside the run is not a number", () => {
    expect(
      retimedInPlace(
        before,
        edited({ 1: { start: 1.2 }, 3: { start: Number.NaN } }),
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

    it("is false when the twin is exactly as far from the old start as the new one", () => {
      const was = model([
        { text: "b", start: 1 },
        { text: "b", start: -1 },
      ]);
      const now = model([
        { text: "b", start: 3 },
        { text: "b", start: -1 },
      ]);
      expect(retimedInPlace(was, now, 0, 0)).toBe(false);
    });

    it("is false when the word is retimed onto the start of a twin below it", () => {
      const was = model([
        { text: "b", start: 1.4 },
        { text: "b", start: 2.0 },
      ]);
      const now = model([
        { text: "b", start: 1.4 },
        { text: "b", start: 1.4 },
      ]);
      expect(retimedInPlace(was, now, 1, 1)).toBe(false);
    });

    it("is false when the word is retimed onto the start of a twin above it", () => {
      const was = model([
        { text: "b", start: 1.4 },
        { text: "b", start: 2.0 },
      ]);
      const now = model([
        { text: "b", start: 2.0 },
        { text: "b", start: 2.0 },
      ]);
      expect(retimedInPlace(was, now, 0, 0)).toBe(false);
    });

    it("is true when the twin is just beyond the distance the word moved", () => {
      const was = model([
        { text: "b", start: 1 },
        { text: "b", start: 2 },
      ]);
      const now = model([
        { text: "b", start: 1.5 },
        { text: "b", start: 2 },
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

describe("retimeKeeps", () => {
  const was = model(BASE);
  const moved = (over: Record<number, Partial<Word>>) =>
    model(BASE.map((w, at) => ({ ...w, ...over[at] })));
  const ends = (m: SelectionModel, from: number, to: number) => ({
    anchor: selectionEndOf(m, from)!,
    head: selectionEndOf(m, to)!,
  });
  const keeps = (now: SelectionModel, from = 1, to = 2) => {
    const { anchor, head } = ends(was, from, to);
    return retimeKeeps(was, now, anchor, head);
  };

  it("keeps a run whose word moved in place", () => {
    expect(keeps(moved({ 1: { start: 1.2 } }))).toBe(true);
  });

  it("keeps a run whose word was respelled in place", () => {
    expect(keeps(moved({ 2: { text: "x" } }))).toBe(true);
  });

  it("does not keep a respelled run whose end is cut", () => {
    const cutBefore = model(BASE.map((w, at) => ({ ...w, cut: at === 2 })));
    const cutAfter = model(
      BASE.map((w, at) => ({
        ...w,
        cut: at === 2,
        text: at === 2 ? "x" : w.text,
      })),
    );
    const { anchor, head } = ends(cutBefore, 1, 2);
    expect(retimeKeeps(cutBefore, cutAfter, anchor, head)).toBe(false);
  });

  it("does not keep when nothing moved", () => {
    expect(keeps(moved({}))).toBe(false);
  });

  it("does not keep a run whose end was cut before and after", () => {
    const cutBefore = model(BASE.map((w, at) => ({ ...w, cut: at === 1 })));
    const cutAfter = model(
      BASE.map((w, at) => ({
        ...w,
        cut: at === 1,
        start: at === 1 ? 1.2 : w.start,
      })),
    );
    const { anchor, head } = ends(cutBefore, 1, 2);
    expect(retimeKeeps(cutBefore, cutAfter, anchor, head)).toBe(false);
    const headCut = model(BASE.map((w, at) => ({ ...w, cut: at === 2 })));
    const headCutAfter = model(
      BASE.map((w, at) => ({
        ...w,
        cut: at === 2,
        start: at === 1 ? 1.2 : w.start,
      })),
    );
    const pair = ends(headCut, 1, 2);
    expect(retimeKeeps(headCut, headCutAfter, pair.anchor, pair.head)).toBe(
      false,
    );
  });

  it("does not keep a run with a held end", () => {
    const now = moved({ 1: { start: 1.2 } });
    const held = {
      ...now,
      wordStarts: now.wordStarts.map((s, at) => (at === 2 ? null : s)),
    };
    expect(keeps(held)).toBe(false);
  });

  it("does not keep a run whose line is drawn as bars", () => {
    const now = moved({ 1: { start: 1.2 } });
    const barred: SelectionModel = {
      ...now,
      turns: [{ words: [] }],
      spans: [{ trackId: "a", sourceId: null, start: 0, end: 5 }],
    };
    expect(keeps(barred)).toBe(false);
  });

  it("does not keep a run whose end was held before it was retimed", () => {
    const held = {
      ...was,
      wordStarts: was.wordStarts.map((s, at) => (at === 2 ? null : s)),
    };
    const { anchor, head } = ends(held, 1, 2);
    expect(retimeKeeps(held, moved({ 1: { start: 1.2 } }), anchor, head)).toBe(
      false,
    );
  });

  it("does not keep a run when only the old start of an end sits in a barred line", () => {
    const barred: SelectionModel = {
      ...moved({ 1: { start: 1.2 } }),
      turns: [{ words: [] }],
      spans: [{ trackId: "a", sourceId: null, start: 0.9, end: 1.05 }],
    };
    expect(keeps(barred)).toBe(false);
  });

  it("does not keep a run when only the new start of an end sits in a barred line", () => {
    const barred: SelectionModel = {
      ...moved({ 1: { start: 1.2 } }),
      turns: [{ words: [] }],
      spans: [{ trackId: "a", sourceId: null, start: 1.1, end: 1.3 }],
    };
    expect(keeps(barred)).toBe(false);
  });
});
