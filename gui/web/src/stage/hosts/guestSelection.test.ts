import { describe, expect, it } from "vitest";
import type { ScriptTurn } from "../../system/scriptPieces";
import {
  followSelection,
  type RememberedSelection,
  type SelectionModel,
  selectionEndOf,
} from "./guestSelection";

type W = { text: string; n: number; held?: true };
type Line = { id: string; words: W[]; bars?: number };

/** A Script the way guestScriptOf lays it out: flat indices over the drawn words. */
function modelOf(lines: Line[]): SelectionModel {
  const refs: SelectionModel["refs"][number][] = [];
  const times: SelectionModel["times"][number][] = [];
  const wordStarts: (number | null)[] = [];
  const turns = lines.map((line): ScriptTurn => {
    return {
      id: line.id,
      speakerId: "a",
      speaker: { name: "Ann", colorIndex: 0 },
      time: "0:00",
      words: line.words.map((w) => {
        const index = refs.length;
        refs.push({ trackId: "a", sourceId: null, wordIndex: w.n });
        times.push(w.held ? null : { start: w.n, end: w.n + 0.5 });
        wordStarts.push(w.held ? null : w.n);
        return { index, key: `a::${w.n}`, text: w.text };
      }),
      ...(line.bars ? { settling: Array(line.bars).fill(3) } : {}),
    } as ScriptTurn;
  });
  return { turns, refs, times, wordStarts };
}
const line = (
  id: string,
  texts: string[],
  first: number,
  held = false,
): Line => ({
  id,
  words: texts.map((text, i) => ({
    text,
    n: first + i,
    ...(held ? { held: true as const } : {}),
  })),
});
const bars = (id: string): Line => ({ id, words: [], bars: 3 });

const before = modelOf([
  line("a:s:0", ["one", "two", "three"], 0),
  line("a:s:9", ["four", "five", "six"], 3),
]);
function remember(
  model: SelectionModel,
  anchor: number,
  head: number,
): RememberedSelection {
  const a = selectionEndOf(model, anchor);
  const h = selectionEndOf(model, head);
  if (!a || !h) throw new Error("no such word");
  return { stored: {}, anchor: a, head: h };
}

describe("followSelection", () => {
  it("keeps a selection whose words did not move", () => {
    expect(followSelection(remember(before, 1, 4), before)).toEqual({
      kind: "keep",
    });
  });

  it("follows the same words to their new numbers after a cut before them", () => {
    const after = modelOf([
      line("a:s:0", ["one", "two", "three"], 0),
      line("a:s:9", ["four", "five", "six"], 1),
    ]);
    expect(followSelection(remember(before, 3, 5), after)).toEqual({
      kind: "move",
      anchor: 3,
      head: 5,
    });
  });

  it("moves when only the numbers changed and every flat position stayed", () => {
    // A cut took struck words from before the selection: nothing drawn moved.
    const after = modelOf([
      line("a:s:0", ["one", "two", "three"], 0),
      line("a:s:9", ["four", "five", "six"], 1),
    ]);
    const picked = remember(before, 4, 5);
    expect(after.turns[1]!.words[1]!.index).toBe(4);
    expect(followSelection(picked, after)).toEqual({
      kind: "move",
      anchor: 4,
      head: 5,
    });
  });

  it("waits while a line of the selection is bars or held, and never moves then", () => {
    expect(
      followSelection(
        remember(before, 1, 4),
        modelOf([line("a:s:0", ["one", "two", "three"], 0), bars("a:s:9")]),
      ),
    ).toEqual({ kind: "wait" });
    const held = modelOf([
      line("a:s:0", ["one", "two", "three"], 0),
      line("a:s:9", ["four", "five", "six"], 1, true),
    ]);
    expect(followSelection(remember(before, 3, 5), held)).toEqual({
      kind: "wait",
    });
  });

  it("clears when the words are not there: a cut through them, or their line gone", () => {
    const cut = modelOf([
      line("a:s:0", ["one", "two", "three"], 0),
      line("a:s:9", ["four", "six"], 3),
    ]);
    expect(followSelection(remember(before, 3, 4), cut)).toEqual({
      kind: "clear",
    });
    expect(followSelection(remember(before, 3, 5), cut)).toEqual({
      kind: "clear",
    });
    expect(
      followSelection(
        remember(before, 3, 4),
        modelOf([line("a:s:0", ["one", "two", "three"], 0)]),
      ),
    ).toEqual({ kind: "clear" });
  });

  it("leaves a selection alone when a correction re-draws another line as bars", () => {
    const after = modelOf([
      bars("a:s:0"),
      line("a:s:9", ["four", "five", "six"], 3),
    ]);
    // The bars line draws no words, so the live line's flat indices shift down,
    // but the numbers and times the store holds are the same: nothing to write.
    const picked = remember(before, 3, 5);
    expect(after.turns[1]!.words[0]!.index).toBe(0);
    expect(followSelection(picked, after)).toEqual({ kind: "keep" });
  });

  it("tells duplicate takes apart by their line", () => {
    const takes = modelOf([
      line("a:s:0", ["yes", "yes"], 0),
      line("a:s:0#2", ["yes", "yes"], 2),
    ]);
    const picked = remember(takes, 2, 3);
    const shifted = modelOf([
      line("a:s:0", ["yes", "yes"], 0),
      line("a:s:0#2", ["yes", "yes"], 5),
    ]);
    expect(followSelection(picked, shifted)).toEqual({
      kind: "move",
      anchor: 2,
      head: 3,
    });
  });
});
