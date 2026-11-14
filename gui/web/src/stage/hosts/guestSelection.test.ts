import { describe, expect, it } from "vitest";
import type { ScriptTurn } from "../../system/scriptPieces";
import {
  followSelection,
  type RememberedSelection,
  type SelectionModel,
  selectionEndOf,
} from "./guestSelection";

/** `n` is the word_index the store holds, `at` the source second: a cut moves `n`, never `at`. */
type W = { text: string; n: number; at: number; held?: true; time?: number };
type Line = {
  id: string;
  words: W[];
  /** A line drawn as bars: the source seconds it covers. */
  bars?: [number, number];
  track?: string;
  source?: string | null;
};

function modelOf(lines: Line[]): SelectionModel {
  const refs: SelectionModel["refs"][number][] = [];
  const times: SelectionModel["times"][number][] = [];
  const wordStarts: (number | null)[] = [];
  const words: { start: number; text: string }[] = [];
  const spans: SelectionModel["spans"][number][] = [];
  const turns = lines.map((line): ScriptTurn => {
    const trackId = line.track ?? "a";
    const sourceId = line.source ?? null;
    spans.push({
      trackId,
      sourceId,
      start: line.bars?.[0] ?? line.words[0]!.at,
      end: line.bars?.[1] ?? line.words[line.words.length - 1]!.at + 0.4,
    });
    return {
      id: line.id,
      speakerId: "a",
      speaker: { name: "Ann", colorIndex: 0 },
      time: "0:00",
      words: line.words.map((w) => {
        const index = refs.length;
        refs.push({ trackId, sourceId, wordIndex: w.n });
        const when = w.time ?? w.at;
        times.push(w.held ? null : { start: when, end: when + 0.4 });
        wordStarts.push(w.held ? null : when);
        words.push({ start: w.at, text: w.text });
        return { index, key: `${trackId}::${w.n}`, text: w.text };
      }),
      ...(line.bars ? { settling: [3, 3] } : {}),
    } as ScriptTurn;
  });
  return { turns, spans, refs, times, wordStarts, words };
}

const line = (
  id: string,
  words: [string, number, number][],
  extra: Partial<Line> = {},
  held = false,
): Line => ({
  id,
  words: words.map(([text, n, at]) => ({
    text,
    n,
    at,
    ...(held ? { held: true as const } : {}),
  })),
  ...extra,
});
const bars = (
  id: string,
  span: [number, number],
  extra: Partial<Line> = {},
): Line => ({
  id,
  words: [],
  bars: span,
  ...extra,
});

function remember(
  model: SelectionModel,
  anchor: number,
  head = anchor,
): RememberedSelection {
  const a = selectionEndOf(model, anchor);
  const h = selectionEndOf(model, head);
  if (!a || !h) throw new Error("no such word");
  return { stored: {}, anchor: a, head: h };
}

// One line "a b a a" at source seconds 1..4, then another line.
const abaa = line("a:0:1", [
  ["a", 0, 1],
  ["b", 1, 2],
  ["a", 2, 3],
  ["a", 3, 4],
]);
const next = line("a:0:9", [
  ["four", 4, 9],
  ["five", 5, 10],
]);
const before = modelOf([abaa, next]);

describe("followSelection", () => {
  it("keeps a selection whose words did not move", () => {
    expect(followSelection(remember(before, 2, 5), before)).toEqual({
      kind: "keep",
    });
  });

  it("follows the same word when a cut takes an equal-text word before it, never the sibling", () => {
    // "b" is cut: the third word (a at 3 s) is now number 1, not 2.
    const after = modelOf([
      line("a:0:1", [
        ["a", 0, 1],
        ["a", 1, 3],
        ["a", 2, 4],
      ]),
      next,
    ]);
    expect(followSelection(remember(before, 2), after)).toEqual({
      kind: "move",
      anchor: 1,
      head: 1,
    });
  });

  it("moves when only the numbers changed and every flat position stayed", () => {
    const after = modelOf([
      abaa,
      line("a:0:9", [
        ["four", 3, 9],
        ["five", 4, 10],
      ]),
    ]);
    expect(followSelection(remember(before, 5), after)).toEqual({
      kind: "move",
      anchor: 5,
      head: 5,
    });
  });

  it("clears when the selected word is cut and an equal-text word takes its place", () => {
    // The third word (a at 3 s) is cut; the fourth (a at 4 s) now sits where it was.
    const after = modelOf([
      line("a:0:1", [
        ["a", 0, 1],
        ["b", 1, 2],
        ["a", 2, 4],
      ]),
      next,
    ]);
    expect(followSelection(remember(before, 2), after)).toEqual({
      kind: "clear",
    });
  });

  it("follows a word into the second block when a cut splits its line", () => {
    const after = modelOf([
      line("a:0:1", [["a", 0, 1]]),
      line("a:0:3", [
        ["a", 1, 3],
        ["a", 2, 4],
      ]),
      next,
    ]);
    expect(followSelection(remember(before, 3), after)).toEqual({
      kind: "move",
      anchor: 2,
      head: 2,
    });
    expect(after.turns[1]!.words[1]!.index).toBe(2);
  });

  it("waits while the word is held or inside a line drawn as bars", () => {
    const held = modelOf([
      line(
        "a:0:1",
        [
          ["a", 0, 1],
          ["b", 1, 2],
          ["a", 2, 3],
          ["a", 3, 4],
        ],
        {},
        true,
      ),
      next,
    ]);
    expect(followSelection(remember(before, 2), held)).toEqual({
      kind: "wait",
    });
    const barred = modelOf([bars("a:0:1", [1, 4.4]), next]);
    expect(followSelection(remember(before, 2), barred)).toEqual({
      kind: "wait",
    });
  });

  it("holds through two cuts before the detail lands, then follows", () => {
    const gap = modelOf([bars("a:0:1", [1, 4.4]), next]);
    const picked = remember(before, 3);
    expect(followSelection(picked, gap)).toEqual({ kind: "wait" });
    expect(followSelection(picked, gap)).toEqual({ kind: "wait" });
    const settled = modelOf([
      line("a:0:1", [
        ["a", 0, 1],
        ["a", 1, 3],
        ["a", 2, 4],
      ]),
      line("a:0:9", [
        ["four", 3, 9],
        ["five", 4, 10],
      ]),
    ]);
    expect(followSelection(picked, settled)).toEqual({
      kind: "move",
      anchor: 2,
      head: 2,
    });
  });

  it("clears when the word is cut, or its text was corrected", () => {
    const cut = modelOf([
      line("a:0:1", [
        ["a", 0, 1],
        ["b", 1, 2],
        ["a", 2, 4],
      ]),
      next,
    ]);
    expect(
      followSelection(
        remember(before, 3),
        modelOf([
          line("a:0:1", [
            ["a", 0, 1],
            ["b", 1, 2],
            ["a", 2, 3],
          ]),
          next,
        ]),
      ),
    ).toEqual({ kind: "clear" });
    expect(followSelection(remember(before, 1), cut)).toEqual({ kind: "keep" });
    const fixed = modelOf([
      line("a:0:1", [
        ["a", 0, 1],
        ["b!", 1, 2],
        ["a", 2, 3],
        ["a", 3, 4],
      ]),
      next,
    ]);
    expect(followSelection(remember(before, 1), fixed)).toEqual({
      kind: "clear",
    });
  });

  it("never follows to the sibling when the first of two duplicate takes disappears", () => {
    // The same words said twice in one recording, at 1 s and at 20 s.
    const takes = modelOf([
      line("a:0:1", [
        ["yes", 0, 1],
        ["no", 1, 2],
      ]),
      line("a:0:20", [
        ["yes", 2, 20],
        ["no", 3, 21],
      ]),
    ]);
    const picked = remember(takes, 0, 1);
    const gone = modelOf([
      line("a:0:20", [
        ["yes", 0, 20],
        ["no", 1, 21],
      ]),
    ]);
    expect(followSelection(picked, gone)).toEqual({ kind: "clear" });
    // The second take is its own selection and follows by its source seconds.
    expect(followSelection(remember(takes, 2, 3), gone)).toEqual({
      kind: "move",
      anchor: 0,
      head: 1,
    });
  });

  it("tells recordings apart by track and source", () => {
    const two = modelOf([
      line("a:s1:1", [["yes", 0, 1]], { source: "s1" }),
      line("a:s2:1", [["yes", 0, 1]], { source: "s2" }),
    ]);
    const only = modelOf([line("a:s2:1", [["yes", 0, 1]], { source: "s2" })]);
    expect(followSelection(remember(two, 0), only)).toEqual({ kind: "clear" });
    expect(followSelection(remember(two, 1), only)).toEqual({ kind: "keep" });
  });

  describe("the same recording placed twice", () => {
    const copy = (id: string, shift: number, n = 0) =>
      line(id, [["yes", n, 5]], {}, false).words.map((w) => ({
        ...w,
        time: 5 + shift,
      }));
    const twoCopies = (shifts: [number, number]) =>
      modelOf([
        { id: "c1", words: copy("c1", shifts[0]) },
        { id: "c2", words: copy("c2", shifts[1]) },
      ]);

    it("keeps the second copy when nothing changed, never moving to the first", () => {
      const model = twoCopies([0, 30]);
      expect(followSelection(remember(model, 1), model)).toEqual({
        kind: "keep",
      });
      expect(followSelection(remember(model, 0), model)).toEqual({
        kind: "keep",
      });
    });

    it("clears when the second placement was picked and that clip is removed, never moving to the first", () => {
      const picked = remember(twoCopies([0, 30]), 1);
      const only = modelOf([{ id: "c1", words: copy("c1", 0) }]);
      expect(followSelection(picked, only)).toEqual({ kind: "clear" });
    });

    it("keeps the first placement when the second clip is removed and nothing else changed", () => {
      const picked = remember(twoCopies([0, 30]), 0);
      const only = modelOf([{ id: "c1", words: copy("c1", 0) }]);
      expect(followSelection(picked, only)).toEqual({ kind: "keep" });
    });

    it("keeps a word picked when unique after the host duplicates its clip", () => {
      const alone = modelOf([{ id: "c1", words: copy("c1", 0) }]);
      expect(followSelection(remember(alone, 0), twoCopies([0, 30]))).toEqual({
        kind: "keep",
      });
    });

    it("clears when a cut elsewhere shifts both copies' times, since the pick cannot be proven", () => {
      const picked = remember(twoCopies([0, 30]), 1);
      expect(followSelection(picked, twoCopies([-5, 25]))).toEqual({
        kind: "clear",
      });
    });

    it("waits while one copy sits inside a line drawn as bars", () => {
      const picked = remember(twoCopies([0, 30]), 1);
      const gap = modelOf([
        bars("c1", [4, 6]),
        { id: "c2", words: copy("c2", 30) },
      ]);
      expect(followSelection(picked, gap)).toEqual({ kind: "wait" });
    });

    it("tells two equal-text words with one start in a line apart only while unchanged", () => {
      const twin = (n2: number) =>
        modelOf([
          line("t", [
            ["um", 0, 5],
            ["um", n2, 5],
          ]),
        ]);
      const model = twin(1);
      expect(followSelection(remember(model, 1), model)).toEqual({
        kind: "keep",
      });
      // Both renumbered: it cannot be told which was picked.
      const both = modelOf([
        line("t", [
          ["um", 4, 5],
          ["um", 5, 5],
        ]),
      ]);
      expect(followSelection(remember(model, 1), both)).toEqual({
        kind: "clear",
      });
    });
  });

  it("never picks a word whose start is not a number", () => {
    const nan = line("n", [["a", 0, Number.NaN]]);
    const real = line("r", [["a", 1, 7]]);
    const model = modelOf([nan, real]);
    expect(followSelection(remember(model, 1), model)).toEqual({
      kind: "keep",
    });
    // A remembered end with no start matches nothing.
    expect(followSelection(remember(model, 0), model)).toEqual({
      kind: "clear",
    });
  });

  it("clears a word that was retimed: its source start changed", () => {
    const retimed = modelOf(
      [abaa, next].map((l) => ({
        ...l,
        words: l.words.map((w) =>
          w.text === "b" ? { ...w, at: w.at + 0.2 } : w,
        ),
      })),
    );
    expect(followSelection(remember(before, 1), retimed)).toEqual({
      kind: "clear",
    });
  });
});
