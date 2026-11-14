import { describe, expect, it } from "vitest";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";
import { rebaseReading } from "./rebaseReading";

function turnsOf(...keys: string[][]): ScriptTurn[] {
  let index = 0;
  return keys.map((names, at) => ({
    id: `turn-${at}-${names[0]}`,
    speakerId: "a",
    speaker: { name: "A", colorIndex: 0 },
    time: "0:00",
    words: names.map((key) => ({ index: index++, key, text: key })),
  }));
}

function at(
  index: number,
  turns: readonly ScriptTurn[],
): Extract<ScriptPaneReadingPosition, { kind: "word" }> {
  return { kind: "word", index, offset: 40, fallbackTop: 900, turns };
}

describe("rebaseReading", () => {
  it("follows the reader's word to its new index at the same offset", () => {
    const before = turnsOf(["a", "b"], ["c", "d"]);
    const after = turnsOf(["c", "d"]);
    expect(rebaseReading(at(2, before), after)).toEqual({
      kind: "word",
      index: 0,
      offset: 40,
      fallbackTop: 900,
      turns: after,
    });
  });

  it("moves to the next surviving word when the reader's word is gone", () => {
    const before = turnsOf(["a", "b"], ["c", "d"]);
    const after = turnsOf(["a"], ["d"]);
    expect(rebaseReading(at(1, before), after)).toMatchObject({
      index: 1,
      offset: 40,
      turns: after,
    });
  });

  it("keeps the position as it was when no word of the old order from there on survives", () => {
    const before = turnsOf(["a", "b"], ["c"]);
    const after = turnsOf(["a"], ["z"]);
    const position = at(1, before);
    expect(rebaseReading(position, after)).toBe(position);
  });

  it("finds a repeated take's own word by its numbered key", () => {
    const before = turnsOf(["x", "x#2"]);
    const after = turnsOf(["x#2"]);
    expect(rebaseReading(at(1, before), after)).toMatchObject({ index: 0 });
  });

  it("returns the same position for the same turns and for a position with no snapshot", () => {
    const turns = turnsOf(["a"]);
    const position = at(0, turns);
    expect(rebaseReading(position, turns)).toBe(position);
    const bare = { ...position, turns: undefined };
    expect(rebaseReading(bare, turns)).toBe(bare);
  });
});
