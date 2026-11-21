import { describe, expect, it } from "vitest";
import { guestScriptOf } from "../../stage/hosts/guestScript";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";
import { captureReading, rebaseReading } from "./rebaseReading";

function replacementFor(
  position: Extract<ScriptPaneReadingPosition, { kind: "word" }>,
  turns: ScriptTurn[],
) {
  return rebaseReading(
    { position, end: null },
    { ...guestScriptOf([]), turns },
  );
}

function turnsOf(...lines: [string, ...string[]][]): ScriptTurn[] {
  let index = 0;
  return lines.map(([id, ...names]) => ({
    id,
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

describe("reading-order fallback for an unidentified word", () => {
  it("keeps the reader at the same place in the same line when a cut renumbers its words", () => {
    const before = turnsOf(["l1", "a21", "a22"], ["l2", "b23", "b24", "b25"]);
    const after = turnsOf(["l2", "b6", "b7", "b8"]);
    expect(replacementFor(at(3, before), after)).toEqual({
      kind: "word",
      index: 1,
      offset: 40,
      fallbackTop: 900,
      turns: after,
    });
  });

  it("follows the same word by key and text when only a word before it was dropped", () => {
    const before = turnsOf(["l1", "a", "b", "c"]);
    const after = turnsOf(["l1", "b", "c"]);
    expect(replacementFor(at(2, before), after)).toMatchObject({ index: 1 });
  });

  it("moves to the first word of the next surviving line when the reader's line is gone", () => {
    const before = turnsOf(["l1", "a", "b"], ["l2", "c", "d"], ["l3", "e"]);
    const after = turnsOf(["l1", "a"], ["l3", "e"]);
    expect(replacementFor(at(3, before), after)).toMatchObject({
      index: 1,
      offset: 40,
      turns: after,
    });
  });

  it("clamps to the last word when the line is now shorter", () => {
    const before = turnsOf(["l1", "a", "b", "c"]);
    const after = turnsOf(["l1", "a", "b"]);
    expect(replacementFor(at(2, before), after)).toMatchObject({ index: 1 });
  });

  it("keeps the position as it was when the reader's own line is now bars", () => {
    const before = turnsOf(["l1", "a", "b"], ["l2", "c"]);
    const after: ScriptTurn[] = [
      { ...before[0]!, words: [], settling: [1, 1] },
      before[1]!,
    ];
    const position = at(1, before);
    expect(replacementFor(position, after)).toBe(position);
  });

  it("keeps the position as it was when no line of the old order from there on survives", () => {
    const before = turnsOf(["l1", "a", "b"], ["l2", "c"]);
    const after = turnsOf(["l1", "a"], ["z", "z"]);
    const position = at(2, before);
    expect(replacementFor(position, after)).toBe(position);
  });

  it("returns the same position for the same turns and for a position with no snapshot", () => {
    const turns = turnsOf(["l1", "a"]);
    const position = at(0, turns);
    expect(replacementFor(position, turns)).toBe(position);
    const bare = { ...position, turns: undefined };
    expect(replacementFor(bare, turns)).toBe(bare);
  });
});

it("only identifies a word drawn by the model where the pane measured it", () => {
  const model = guestScriptOf([
    {
      kind: "live",
      utterance: {
        track_id: "track",
        source_id: "source",
        speaker: "A",
        text: "ghost",
        start: 8.49,
        end: 8.79,
        words: [
          {
            text: "ghost",
            start: 8.49,
            end: 8.79,
            timeline_start: 3.49,
            timeline_end: 3.79,
            word_index: 9,
          },
        ],
      },
    },
  ]);
  expect(captureReading(at(0, model.turns), model).end).toMatchObject({
    trackId: "track",
    sourceId: "source",
    start: 8.49,
    text: "ghost",
    copies: 1,
  });
  expect(
    captureReading(at(0, turnsOf(["other", "ghost"])), model).end,
  ).toBeNull();
});
