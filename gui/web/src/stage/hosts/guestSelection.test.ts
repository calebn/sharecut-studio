import { describe, expect, it } from "vitest";
import type { ScriptTurn } from "../../system/scriptPieces";
import {
  followSelection,
  type RememberedSelection,
  selectionEndOf,
} from "./guestSelection";

function turn(
  id: string,
  texts: string[],
  first: number,
  bars = false,
): ScriptTurn {
  return {
    id,
    speakerId: "a",
    speaker: { name: "Ann", colorIndex: 0 },
    time: "0:00",
    words: texts.map((text, at) => ({
      index: first + at,
      key: `${id}:${first + at}`,
      text,
    })),
    ...(bars ? { settling: texts.map((t) => t.length) } : {}),
  } as ScriptTurn;
}
const bars = (id: string, n: number): ScriptTurn =>
  ({ ...turn(id, [], 0), settling: Array(n).fill(3) }) as ScriptTurn;

const before = [
  turn("a:s:0", ["one", "two", "three"], 0),
  turn("a:s:9", ["four", "five", "six"], 3),
];
function remember(anchor: number, head: number): RememberedSelection {
  const a = selectionEndOf(before, anchor);
  const h = selectionEndOf(before, head);
  if (!a || !h) throw new Error("no such word");
  return { stored: {}, anchor: a, head: h };
}

describe("followSelection", () => {
  it("keeps a selection whose words did not move", () => {
    expect(followSelection(remember(1, 4), before)).toEqual({ kind: "keep" });
  });

  it("follows the same words to their new numbers after a ripple cut before them", () => {
    const after = [
      turn("a:s:0", ["one", "two", "three"], 0),
      turn("a:s:9", ["four", "five", "six"], 1),
    ];
    expect(followSelection(remember(3, 5), after)).toEqual({
      kind: "move",
      anchor: 1,
      head: 3,
    });
  });

  it("waits while a line of the selection is bars", () => {
    const after = [before[0]!, bars("a:s:9", 3)];
    expect(followSelection(remember(1, 4), after)).toEqual({ kind: "wait" });
  });

  it("clears when the words are not there: a cut through them, or their line gone", () => {
    const cut = [before[0]!, turn("a:s:9", ["four", "six"], 3)];
    expect(followSelection(remember(3, 4), cut)).toEqual({ kind: "clear" });
    expect(followSelection(remember(3, 5), cut)).toEqual({ kind: "clear" });
    expect(followSelection(remember(3, 4), [before[0]!])).toEqual({
      kind: "clear",
    });
  });

  it("leaves a selection alone when a correction elsewhere re-draws another line", () => {
    const after = [bars("a:s:0", 3), before[1]!];
    expect(followSelection(remember(3, 5), after)).toEqual({ kind: "keep" });
  });

  it("tells duplicate takes apart by their line", () => {
    const takes = [
      turn("a:s:0", ["yes", "yes"], 0),
      turn("a:s:0#2", ["yes", "yes"], 2),
    ];
    const picked = {
      stored: {},
      anchor: selectionEndOf(takes, 2)!,
      head: selectionEndOf(takes, 3)!,
    };
    const shifted = [
      turn("a:s:0", ["yes", "yes"], 0),
      turn("a:s:0#2", ["yes", "yes"], 5),
    ];
    expect(followSelection(picked, shifted)).toEqual({
      kind: "move",
      anchor: 5,
      head: 6,
    });
  });
});
