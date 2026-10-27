import { describe, expect, it } from "vitest";
import { replaceSpan, SCRIPT_TURNS, textOfSpan } from "./scriptFixtures";

const texts = (turn: number) =>
  replaceSpan(SCRIPT_TURNS, { start: 12, end: 14 }, "tiny studio")[
    turn
  ].words.map((w) => `${w.index}:${w.text}`);

describe("script fixtures", () => {
  it("reads a span as one string", () => {
    expect(textOfSpan(SCRIPT_TURNS, { start: 12, end: 14 })).toBe(
      "small room can",
    );
    expect(textOfSpan(SCRIPT_TURNS, { start: 19, end: 20 })).toBe(
      "one. Thanks",
    );
  });

  it("swaps the words under a span for the new ones and keeps the indices running", () => {
    expect(texts(0).slice(10)).toEqual([
      "10:how",
      "11:a",
      "12:tiny",
      "13:studio",
      "14:sound",
      "15:like",
      "16:a",
      "17:large",
      "18:one.",
    ]);
    expect(texts(1)[0]).toBe("19:Thanks");
    expect(
      replaceSpan(SCRIPT_TURNS, { start: 12, end: 14 }, "tiny studio")[3]
        .words[0],
    ).toEqual({ index: 44, key: "episode:44", text: "So," });
  });

  it("grows when the new text has more words", () => {
    const turns = replaceSpan(
      SCRIPT_TURNS,
      { start: 12, end: 12 },
      "a very small",
    );
    expect(turns[0].words.slice(11, 16).map((w) => w.text)).toEqual([
      "a",
      "a",
      "very",
      "small",
      "room",
    ]);
    expect(turns[3].words[0].index).toBe(47);
  });
});
