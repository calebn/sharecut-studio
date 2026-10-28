import { describe, expect, it } from "vitest";
import type {
  CombinedUtterance,
  TranscriptWordView,
} from "../../types/project";
import { guestScriptOf, playingWordsAt } from "./guestScript";

const word = (
  text: string,
  start: number | null,
  extra: Partial<TranscriptWordView> = {},
): TranscriptWordView => ({
  text,
  start: 0,
  end: 0,
  timeline_start: start,
  timeline_end: start === null ? null : start + 0.5,
  ...extra,
});

const utterance = (
  speaker: string,
  words: TranscriptWordView[],
  track = "t1",
): CombinedUtterance => ({
  track_id: track,
  source_id: "s1",
  speaker,
  start: 0,
  end: 0,
  text: "",
  words,
});

describe("guestScriptOf", () => {
  it("is empty for no utterances and for utterances with no heard words", () => {
    expect(guestScriptOf([])).toEqual({ turns: [], wordStarts: [], words: [] });
    expect(
      guestScriptOf([
        utterance("Maya", [word("gone", 1, { suppressed: true })]),
        { ...utterance("Maya", []), words: undefined },
      ]),
    ).toEqual({ turns: [], wordStarts: [], words: [] });
  });

  it("orders turns by time and numbers words across them", () => {
    const { turns, wordStarts } = guestScriptOf([
      utterance("Maya", [word("Hello", 724), word("there", 725)]),
      utterance("Anneke", [word("Thanks", 20), word("Maya", 20.5)], "t2"),
    ]);
    expect(turns.map((t) => [t.speaker.name, t.time])).toEqual([
      ["Anneke", "0:20"],
      ["Maya", "12:04"],
    ]);
    expect(turns.flatMap((t) => t.words.map((w) => [w.index, w.text]))).toEqual(
      [
        [0, "Thanks"],
        [1, "Maya"],
        [2, "Hello"],
        [3, "there"],
      ],
    );
    expect(wordStarts).toEqual([20, 20.5, 724, 725]);
  });

  it("leaves out cut, ignored and unplaced words", () => {
    const { turns, wordStarts } = guestScriptOf([
      utterance("Maya", [
        word("keep", 1),
        word("cut", 2, { suppressed: true }),
        word("skip", 3, { ignored: true }),
        word("nowhere", null),
        word("also", 4),
      ]),
    ]);
    expect(turns[0]?.words.map((w) => w.text)).toEqual(["keep", "also"]);
    expect(wordStarts).toEqual([1, 4]);
  });

  it("sorts a turn's words by time and keys them by track, source and word index", () => {
    const { turns } = guestScriptOf([
      utterance("Maya", [
        word("b", 2, { word_index: 7 }),
        word("a", 1, { word_index: 6 }),
      ]),
    ]);
    expect(turns[0]?.words.map((w) => [w.text, w.key])).toEqual([
      ["a", "t1:s1:6"],
      ["b", "t1:s1:7"],
    ]);
  });

  it("keeps each word's own start over overlapping speech", () => {
    const { wordStarts, turns } = guestScriptOf([
      utterance("Maya", [word("one", 10), word("two", 14)]),
      utterance("Anneke", [word("over", 12)], "t2"),
    ]);
    expect(wordStarts).toEqual([10, 14, 12]);
    expect(turns.map((t) => t.words.map((w) => w.text))).toEqual([
      ["one", "two"],
      ["over"],
    ]);
  });

  it("finds every word being spoken at a time, overlaps included", () => {
    const { words } = guestScriptOf([
      utterance("Maya", [word("one", 10), word("two", 14)]),
      utterance("Anneke", [word("over", 12)], "t2"),
    ]);
    expect(playingWordsAt(words, 9.9)).toEqual([]);
    expect(playingWordsAt(words, 10.2)).toEqual([0]);
    expect(playingWordsAt(words, 12.2)).toEqual([2]);
    expect(playingWordsAt(words, 14.2)).toEqual([1]);
    const crosstalk = guestScriptOf([
      utterance("Maya", [{ ...word("long", 10), timeline_end: 13 }]),
      utterance("Anneke", [word("over", 12)], "t2"),
    ]);
    expect(playingWordsAt(crosstalk.words, 12.2)).toEqual([0, 1]);
  });

  it("measures the pause before each turn from the last word's end", () => {
    const { turns } = guestScriptOf([
      utterance("Maya", [word("a", 10), word("b", 11)]),
      utterance("Maya", [word("c", 13)]),
    ]);
    expect(turns.map((t) => t.pauseBefore)).toEqual([undefined, 1.5]);
  });

  it("measures a pause from the latest end of every earlier turn", () => {
    const { turns } = guestScriptOf([
      utterance("Maya", [{ ...word("long", 10), timeline_end: 20 }]),
      utterance("Anneke", [word("short", 12)], "t2"),
      utterance("Maya", [word("later", 23)]),
    ]);
    expect(turns.map((t) => t.pauseBefore)).toEqual([undefined, 0, 3]);
  });

  it("gives each speaker one presence colour, in order of first speech", () => {
    const { turns } = guestScriptOf([
      utterance("Maya", [word("a", 1)]),
      utterance("Anneke", [word("b", 2)], "t2"),
      utterance("Maya", [word("c", 3)]),
    ]);
    expect(turns.map((t) => [t.speakerId, t.speaker.colorIndex])).toEqual([
      ["Maya", 0],
      ["Anneke", 1],
      ["Maya", 0],
    ]);
  });
});
