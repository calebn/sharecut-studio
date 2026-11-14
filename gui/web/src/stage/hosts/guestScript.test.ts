import { describe, expect, it } from "vitest";
import { lastStartedWordAt } from "../../stages/guest/guestLogic";
import type {
  CombinedUtterance,
  TranscriptWordView,
} from "../../types/project";
import { wordsTargetOf } from "../edit/script/scriptModel";
import {
  guestScriptModelOf,
  guestScriptOf,
  playingWordsAt,
} from "./guestScript";

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
  extra: Partial<CombinedUtterance> = {},
): CombinedUtterance => ({
  track_id: track,
  source_id: "s1",
  speaker,
  start: 0,
  end: 0,
  text: "",
  words,
  ...extra,
});

const scriptOf = (utterances: CombinedUtterance[]) =>
  guestScriptOf(utterances.map((u) => ({ kind: "live", utterance: u })));

describe("guestScriptOf ids and unplaced words", () => {
  it("gives two utterances on one track with the same first start different turn ids", () => {
    const { turns } = scriptOf([
      utterance("Maya", [word("one", 5)]),
      utterance("Maya", [word("two", 5)]),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["t1:s1:0", "t1:s1:0#2"]);
  });

  it("says unplaced only for mappable words with no timeline start, and cut for the rest", () => {
    const empty = (...words: TranscriptWordView[]) =>
      scriptOf([utterance("Maya", words)]).empty;
    expect(empty(word("a", null), word("b", null, { suppressed: true }))).toBe(
      "unplaced",
    );
    expect(
      empty(
        word("a", null, { mappable: false }),
        word("b", null, { ignored: true }),
      ),
    ).toBe("cut");
    expect(empty(word("a", null, { mappable: false }), word("b", null))).toBe(
      "unplaced",
    );
    expect(scriptOf([]).empty).toBe("none");
    expect(
      scriptOf([{ ...utterance("Maya", []), words: undefined }]).empty,
    ).toBe("untimed");
  });

  it("keeps word keys unique when two utterances share a track, source and word index", () => {
    const { turns } = scriptOf([
      utterance("Maya", [word("a", 1, { word_index: 0 })]),
      utterance("Maya", [word("b", 2, { word_index: 0 })]),
    ]);
    const keys = turns.flatMap((turn) => turn.words.map((w) => w.key));
    expect(keys).toEqual(["t1:s1:0", "t1:s1:0#2"]);
  });
});

describe("guestScriptOf", () => {
  it("is empty for no utterances and for utterances with no heard words", () => {
    expect(scriptOf([])).toEqual({
      turns: [],
      wordStarts: [],
      words: [],
      refs: [],
      times: [],
      empty: "none",
    });
    expect(
      scriptOf([
        utterance("Maya", [word("gone", 1, { suppressed: true })]),
        { ...utterance("Maya", []), words: undefined },
      ]),
    ).toEqual({
      turns: [],
      wordStarts: [],
      words: [],
      refs: [],
      times: [],
      empty: "cut",
    });
  });

  it("orders turns by time and numbers words across them", () => {
    const { turns, wordStarts } = scriptOf([
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
    const { turns, wordStarts } = scriptOf([
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
    const { turns } = scriptOf([
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
    const { wordStarts, turns } = scriptOf([
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
    const { words } = scriptOf([
      utterance("Maya", [word("one", 10), word("two", 14)]),
      utterance("Anneke", [word("over", 12)], "t2"),
    ]);
    expect(playingWordsAt(words, 9.9)).toEqual([]);
    expect(playingWordsAt(words, 10.2)).toEqual([0]);
    expect(playingWordsAt(words, 12.2)).toEqual([2]);
    expect(playingWordsAt(words, 14.2)).toEqual([1]);
    const crosstalk = scriptOf([
      utterance("Maya", [{ ...word("long", 10), timeline_end: 13 }]),
      utterance("Anneke", [word("over", 12)], "t2"),
    ]);
    expect(playingWordsAt(crosstalk.words, 12.2)).toEqual([0, 1]);
  });

  it("measures the pause before each turn from the last word's end", () => {
    const { turns } = scriptOf([
      utterance("Maya", [word("a", 10), word("b", 11)]),
      utterance("Maya", [word("c", 13)]),
    ]);
    expect(turns.map((t) => t.pauseBefore)).toEqual([undefined, 1.5]);
  });

  it("measures a pause from the latest end of every earlier turn", () => {
    const { turns } = scriptOf([
      utterance("Maya", [{ ...word("long", 10), timeline_end: 20 }]),
      utterance("Anneke", [word("short", 12)], "t2"),
      utterance("Maya", [word("later", 23)]),
    ]);
    expect(turns.map((t) => t.pauseBefore)).toEqual([undefined, 0, 3]);
  });

  it("gives each speaker one presence colour, in order of first speech", () => {
    const { turns } = scriptOf([
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

describe("turn ids", () => {
  it("name the track, source and where the row starts in the source, never a timeline time", () => {
    const row = (at: number) =>
      utterance("Maya", [word("a", at), word("b", at + 1)], "t1", {
        start: 40,
      });
    expect(scriptOf([row(4)]).turns[0]?.id).toBe("t1:s1:40");
    expect(scriptOf([row(9)]).turns[0]?.id).toBe("t1:s1:40");
  });
});

describe("guestScriptOf over held and waiting rows", () => {
  const header = (
    speaker: string,
    text: string,
    at: number,
    extra: Partial<CombinedUtterance> = {},
  ): CombinedUtterance => ({
    track_id: "t1",
    source_id: "s1",
    speaker,
    start: 10,
    end: 12,
    text,
    timeline_start: at,
    timeline_end: at + 2,
    ...extra,
  });
  const untimed = (text: string, index: number): TranscriptWordView => ({
    text,
    start: 0,
    end: 0,
    word_index: index,
    timeline_start: null,
    timeline_end: null,
  });

  it("gives a held word no seek time, no time span and never a playing mark", () => {
    const g = guestScriptOf([
      {
        kind: "held",
        lead: 0,
        utterance: {
          ...header("Maya", "a b", 5),
          words: [untimed("a", 4), untimed("b", 5)],
        },
      },
    ]);
    expect(g.wordStarts).toEqual([null, null]);
    expect(g.times).toEqual([null, null]);
    expect(g.refs.map((r) => r.wordIndex)).toEqual([4, 5]);
    expect(playingWordsAt(g.words, 5.2)).toEqual([]);
    expect(g.turns[0]?.words.map((w) => w.key)).toEqual(["t1:s1:4", "t1:s1:5"]);
    expect(g.turns[0]?.time).toBe("0:05");
  });

  it("orders and labels a held row by its row start plus its lead", () => {
    const g = guestScriptOf([
      {
        kind: "held",
        lead: 4,
        utterance: { ...header("Maya", "a", 2), words: [untimed("a", 0)] },
      },
      {
        kind: "live",
        utterance: {
          ...header("Anneke", "z", 6, { start: 50 }),
          words: [{ ...word("z", 6), word_index: 0 }],
        },
      },
    ]);
    expect(g.turns.map((t) => [t.speaker.name, t.time])).toEqual([
      ["Maya", "0:06"],
      ["Anneke", "0:06"],
    ]);
  });

  it("draws a waiting row as its word lengths and no words, never its text", () => {
    const g = guestScriptOf([
      { kind: "waiting", utterance: header("Maya", "Hello  wide world", 3) },
    ]);
    expect(g.turns).toHaveLength(1);
    expect(g.turns[0]?.settling).toEqual([5, 4, 5]);
    expect(g.turns[0]?.words).toEqual([]);
    expect(g.words).toEqual([]);
    expect(g.wordStarts).toEqual([]);
    expect(
      guestScriptOf([{ kind: "waiting", utterance: header("Maya", "", 3) }])
        .turns,
    ).toEqual([]);
  });

  it("gives a row the same turn id whether it is live, held or waiting", () => {
    const live = header("Maya", "a", 3, {
      words: [{ ...word("a", 3), word_index: 0 }],
    });
    const idOf = (row: Parameters<typeof guestScriptOf>[0][number]) =>
      guestScriptOf([row]).turns[0]?.id;
    expect(idOf({ kind: "live", utterance: live })).toBe("t1:s1:10");
    expect(
      idOf({
        kind: "held",
        lead: 0,
        utterance: { ...live, words: [untimed("a", 0)] },
      }),
    ).toBe("t1:s1:10");
    expect(
      idOf({ kind: "waiting", utterance: { ...live, words: undefined } }),
    ).toBe("t1:s1:10");
  });

  it("keeps a word's key when an earlier row is removed", () => {
    const first = header("Maya", "a", 3, {
      start: 10,
      words: [{ ...word("a", 3), word_index: 10 }],
    });
    const second = header("Maya", "b", 8, {
      start: 20,
      words: [{ ...word("b", 8), word_index: 20 }],
    });
    const keyOfB = (rows: CombinedUtterance[]) =>
      scriptOf(rows)
        .turns.flatMap((t) => t.words)
        .find((w) => w.text === "b")?.key;
    expect(keyOfB([first, second])).toBe(keyOfB([second]));
  });

  it("says nothing is placed from live rows only", () => {
    const g = guestScriptOf([
      { kind: "waiting", utterance: header("Maya", "a b", 3) },
    ]);
    expect(g.empty).toBe("untimed");
  });
});

describe("lastStartedWordAt", () => {
  it("is undefined before the first word starts", () => {
    expect(lastStartedWordAt([2, 4], 1.9)).toBeUndefined();
    expect(lastStartedWordAt([], 5)).toBeUndefined();
  });

  it("counts a word that starts exactly at the time", () => {
    expect(lastStartedWordAt([2, 4, 6], 4)).toBe(1);
    expect(lastStartedWordAt([2, 4, 6], 3.999)).toBe(0);
  });

  it("lets the later index win when two words start together", () => {
    expect(lastStartedWordAt([2, 4, 4], 5)).toBe(2);
    expect(lastStartedWordAt([4, 4], 4)).toBe(1);
  });

  it("picks the latest started word among ascending starts", () => {
    expect(lastStartedWordAt([1, 3, 5], 4)).toBe(1);
    expect(lastStartedWordAt([1, 3, 5], 99)).toBe(2);
  });

  it("goes by start time, not index, when overlapping speech reorders starts", () => {
    expect(lastStartedWordAt([10, 14, 12], 13)).toBe(2);
  });

  it("skips a word whose time is not known", () => {
    expect(lastStartedWordAt([null, 4, null], 5)).toBe(1);
    expect(lastStartedWordAt([null, null], 5)).toBeUndefined();
  });
});

describe("guestScriptModelOf", () => {
  const indexed = (
    text: string,
    start: number,
    wordIndex: number | undefined,
  ): TranscriptWordView => ({
    ...word(text, start),
    ...(wordIndex === undefined ? {} : { word_index: wordIndex }),
  });

  it("keeps refs and times parallel to the words after the time sort", () => {
    const g = scriptOf([
      utterance("Maya", [indexed("late", 9, 0), indexed("early", 3, 1)]),
    ]);
    expect(g.words.map((w) => w.text)).toEqual(["early", "late"]);
    expect(g.refs).toEqual([
      { trackId: "t1", sourceId: "s1", wordIndex: 1 },
      { trackId: "t1", sourceId: "s1", wordIndex: 0 },
    ]);
    expect(g.times).toEqual([
      { start: 3, end: 3.5 },
      { start: 9, end: 9.5 },
    ]);
  });

  it("gives a word with no timeline end no time, never a zero-length one", () => {
    const g = scriptOf([
      utterance("Maya", [
        { ...indexed("a", 1, 0), timeline_end: null },
        indexed("b", 2, 1),
      ]),
    ]);
    const model = guestScriptModelOf(g);
    expect(model.timeOf(0)).toBeNull();
    expect(model.timeOf(1)).toEqual({ start: 2, end: 2.5 });
    expect(model.seekSecOf(0)).toBe(1);
  });

  it("round-trips a word through indexOf and reads seek, time and cut", () => {
    const g = scriptOf([
      utterance("Maya", [indexed("a", 1, 4), indexed("b", 2, 5)]),
    ]);
    const model = guestScriptModelOf(g);
    expect(model.indexOf(g.refs[1]!)).toBe(1);
    expect(model.indexOf({ trackId: "t1", sourceId: "s1", wordIndex: 9 })).toBe(
      undefined,
    );
    expect(model.seekSecOf(1)).toBe(2);
    expect(model.timeOf(1)).toEqual({ start: 2, end: 2.5 });
    expect(model.isCut(0)).toBe(false);
  });

  it("gives a word with no project index a null ref index and no lookup", () => {
    const g = scriptOf([utterance("Maya", [indexed("a", 1, undefined)])]);
    expect(g.refs[0]?.wordIndex).toBeNull();
    expect(guestScriptModelOf(g).indexOf(g.refs[0]!)).toBeUndefined();
  });

  it("feeds wordsTargetOf a track target for one lane and a time target across two", () => {
    const g = scriptOf([
      utterance("Maya", [indexed("a", 1, 0), indexed("b", 2, 1)]),
      utterance("Anneke", [indexed("c", 3, 0)], "t2"),
    ]);
    const model = guestScriptModelOf(g);
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 0, head: 1 }),
    ).toMatchObject({
      kind: "track",
      trackId: "t1",
      startWordIndex: 0,
      endWordIndex: 1,
    });
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 0, head: 2 }),
    ).toMatchObject({
      kind: "time",
      start: 1,
      end: 3.5,
    });
  });
});
