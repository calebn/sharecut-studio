import { describe, expect, it } from "vitest";
import { transcriptWordPresenceAnchor } from "../../../presence/anchors";
import type {
  CombinedUtterance,
  EditBoundaryView,
  PendingEditView,
  TranscriptWordView,
} from "../../../types/project";
import {
  buildScriptModel,
  type ScriptModelInput,
  scriptSelectionOf,
  speakerColorIndex,
  wordKey,
  wordsTargetOf,
} from "./scriptModel";

function word(
  text: string,
  wordIndex: number,
  start: number,
  extra: Partial<TranscriptWordView> = {},
): TranscriptWordView {
  return {
    text,
    word_index: wordIndex,
    start,
    end: start + 0.4,
    timeline_start: start,
    timeline_end: start + 0.4,
    mappable: true,
    ...extra,
  };
}

function utterance(
  trackId: string,
  speaker: string,
  words: TranscriptWordView[],
  extra: Partial<CombinedUtterance> = {},
): CombinedUtterance {
  return {
    track_id: trackId,
    source_id: null,
    speaker,
    start: words[0]?.start ?? 0,
    end: words[words.length - 1]?.end ?? 0,
    text: words.map((w) => w.text).join(" "),
    timeline_start: words[0]?.timeline_start ?? null,
    timeline_end: words[words.length - 1]?.timeline_end ?? null,
    mappable: true,
    words,
    ...extra,
  };
}

const person = (trackId: string, speaker: string) => ({
  name: speaker || trackId,
  colorIndex: trackId === "host" ? 0 : 1,
});

const NONE = { boundaries: [], pending: [], person };

function input(
  utterances: CombinedUtterance[],
  extra: Partial<ScriptModelInput> = {},
): ScriptModelInput {
  return { ...NONE, utterances, ...extra };
}

const HOST = utterance("host", "Maya", [
  word("Welcome", 0, 12),
  word("back", 1, 12.5),
  word("friends", 2, 13),
]);
const GUEST = utterance("guest", "Anneke", [
  word("Thanks", 0, 20),
  word("so", 1, 20.5),
  word("much", 2, 21),
]);

describe("buildScriptModel", () => {
  it("turns utterances into turns with window indices and project refs", () => {
    const model = buildScriptModel(input([HOST, GUEST]));
    expect(model.turns).toHaveLength(2);
    expect(model.turns[0]?.words.map((w) => [w.index, w.text])).toEqual([
      [0, "Welcome"],
      [1, "back"],
      [2, "friends"],
    ]);
    expect(model.turns[1]?.words[0]?.index).toBe(3);
    expect(model.refs[3]).toEqual({
      trackId: "guest",
      sourceId: null,
      wordIndex: 0,
    });
    expect(model.turns[0]?.words[0]?.key).toBe("host::0");
  });

  it("gives each project word the presence anchor other people's cursors look for", () => {
    const model = buildScriptModel(input([HOST, GUEST]));
    expect(model.turns[1]?.words[2]?.anchor).toBe(
      transcriptWordPresenceAnchor("guest", null, 2),
    );
    const anchors = model.turns.flatMap((t) => t.words.map((w) => w.anchor));
    expect(new Set(anchors).size).toBe(6);
  });

  it("gives a word with no project index no anchor", () => {
    const loose = utterance("host", "Maya", [
      word("Hi", 0, 1, { word_index: undefined }),
    ]);
    expect(
      buildScriptModel(input([loose])).turns[0]?.words[0]?.anchor,
    ).toBeUndefined();
  });

  it("merges consecutive utterances of one speaker into one turn", () => {
    const more = utterance("host", "Maya", [word("again", 3, 14)]);
    const model = buildScriptModel(input([HOST, more, GUEST]));
    expect(model.turns).toHaveLength(2);
    expect(model.turns[0]?.words.map((w) => w.text)).toEqual([
      "Welcome",
      "back",
      "friends",
      "again",
    ]);
  });

  it("names the speaker, the start time and the pause before a turn", () => {
    const model = buildScriptModel(input([HOST, GUEST]));
    expect(model.turns[0]).toMatchObject({
      speakerId: "host",
      speaker: { name: "Maya", colorIndex: 0 },
      time: "0:12",
    });
    expect(model.turns[0]?.pauseBefore).toBeUndefined();
    expect(model.turns[1]?.pauseBefore).toBeCloseTo(20 - 13.4, 5);
  });

  it("looks a project word up by ref, and misses an unknown one", () => {
    const model = buildScriptModel(input([HOST, GUEST]));
    expect(
      model.indexOf({ trackId: "guest", sourceId: null, wordIndex: 2 }),
    ).toBe(5);
    expect(
      model.indexOf({ trackId: "guest", sourceId: "x", wordIndex: 2 }),
    ).toBeUndefined();
  });

  it("gives the seek time and span of a word, and none for a cut-away word", () => {
    const cutAway = utterance(
      "host",
      "Maya",
      [word("um", 3, 15, { mappable: false, timeline_start: null })],
      { mappable: false },
    );
    const model = buildScriptModel(input([HOST, cutAway]));
    expect(model.seekSecOf(1)).toBe(12.5);
    expect(model.timeOf(1)).toEqual({ start: 12.5, end: 12.9 });
    expect(model.seekSecOf(3)).toBeNull();
    expect(model.timeOf(3)).toBeNull();
  });

  it("flags unsure words and mutes ignored and suppressed ones", () => {
    const flagged = utterance("host", "Maya", [
      word("maybe", 0, 1, { unsure: true }),
      word("skip", 1, 2, { ignored: true }),
      word("gone", 2, 3, { suppressed: true }),
      word("plain", 3, 4),
    ]);
    const words = buildScriptModel(input([flagged])).turns[0]?.words ?? [];
    expect(words[0]).toMatchObject({ lowConfidence: true });
    expect(words[0]?.mark).toBeUndefined();
    expect(words[1]?.mark).toEqual({ kind: "muted" });
    expect(words[2]?.mark).toEqual({ kind: "muted" });
    expect(words[3]?.mark).toBeUndefined();
    expect(words[3]?.lowConfidence).toBeUndefined();
  });

  it("puts the words an applied cut took out back at its join, as cut words", () => {
    const boundary = {
      id: "b1",
      track_id: "host",
      timeline_join_sec: 12.5,
      has_cutaway: true,
      cutaway_source_start: 12.5,
      cutaway_source_end: 14,
      cutaway_word_ids: [
        {
          track_id: "host",
          source_id: null,
          word_index: -3,
          text: "uh",
          start: 12.5,
          end: 12.9,
        },
        {
          track_id: "host",
          source_id: null,
          word_index: -4,
          text: "well",
          start: 13,
          end: 13.4,
        },
      ],
    } as unknown as EditBoundaryView;
    const joined = utterance("host", "Maya", [
      word("Welcome", 0, 12),
      word("friends", 3, 12.5),
    ]);
    const model = buildScriptModel(input([joined], { boundaries: [boundary] }));
    const words = model.turns[0]?.words ?? [];
    expect(words.map((w) => w.text)).toEqual([
      "Welcome",
      "uh",
      "well",
      "friends",
    ]);
    expect(words[0]?.mark).toBeUndefined();
    expect(words[1]?.mark).toEqual({ kind: "cut", id: "b1", seconds: 1.5 });
    expect(words[2]?.mark).toEqual({ kind: "cut", id: "b1", seconds: 1.5 });
    expect(words[3]?.mark).toBeUndefined();
    expect(model.isCut(1)).toBe(true);
    expect(model.seekSecOf(1)).toBeNull();
    expect(
      model.indexOf({ trackId: "host", sourceId: null, wordIndex: 3 }),
    ).toBe(3);
    // A cut word is shown, never addressed: no cursor can land on it.
    expect(words.map((w) => w.anchor !== undefined)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("ignores a boundary with no cutaway", () => {
    const boundary = {
      id: "b2",
      track_id: "host",
      has_cutaway: false,
      cutaway_source_start: 0,
      cutaway_source_end: 0,
      cutaway_word_ids: [],
    } as unknown as EditBoundaryView;
    const words =
      buildScriptModel(input([HOST], { boundaries: [boundary] })).turns[0]
        ?.words ?? [];
    expect(words.every((w) => w.mark === undefined)).toBe(true);
  });

  it("marks the words under a pending edit as suggested, on its tracks only", () => {
    const edit = (over: Partial<PendingEditView>) =>
      ({
        id: "p1",
        track_id: "host",
        applied: false,
        source_start: 12.4,
        source_end: 13.5,
        ...over,
      }) as PendingEditView;
    const marksOf = (pending: PendingEditView[]) =>
      buildScriptModel(input([HOST, GUEST], { pending })).turns.flatMap((t) =>
        t.words.map((w) => w.mark?.kind ?? null),
      );
    expect(marksOf([edit({})])).toEqual([
      null,
      "suggested",
      "suggested",
      null,
      null,
      null,
    ]);
    expect(marksOf([edit({ applied: true })]).every((m) => m === null)).toBe(
      true,
    );
    expect(
      marksOf([edit({ track_id: "other", track_ids: ["guest"] })]).slice(0, 3),
    ).toEqual([null, null, null]);
  });

  it("marks only cut suggestions, and reads the guest track from track_ids", () => {
    const edit = (over: Partial<PendingEditView>) =>
      ({
        id: "p1",
        type: "remove",
        track_id: "host",
        applied: false,
        source_start: 20.4,
        source_end: 21.5,
        ...over,
      }) as PendingEditView;
    const marksOf = (pending: PendingEditView[]) =>
      buildScriptModel(input([HOST, GUEST], { pending }))
        .turns.flatMap((t) => t.words)
        .map((w) => w.mark?.kind ?? null);
    expect(marksOf([edit({ track_ids: ["guest"] })]).slice(3)).toEqual([
      null,
      "suggested",
      "suggested",
    ]);
    expect(
      marksOf([edit({ type: "mute", track_ids: ["guest"] })]).every(
        (m) => m === null,
      ),
    ).toBe(true);
  });

  it("lets a suggestion win over muted", () => {
    const flagged = utterance("host", "Maya", [
      word("a", 0, 1, { ignored: true }),
      word("b", 1, 2, { ignored: true }),
    ]);
    const pending = [
      {
        id: "p",
        track_id: "host",
        applied: false,
        source_start: 1.9,
        source_end: 2.5,
      },
    ] as PendingEditView[];
    const words =
      buildScriptModel(input([flagged], { pending })).turns[0]?.words ?? [];
    expect(words[0]?.mark).toEqual({ kind: "muted" });
    expect(words[1]?.mark).toEqual({ kind: "suggested", id: "p" });
  });

  it("falls back to one token when an utterance has no word timings", () => {
    const bare = utterance("host", "Maya", [], {
      words: undefined,
      text: "Hello there",
    });
    const model = buildScriptModel(input([bare]));
    expect(model.turns[0]?.words.map((w) => w.text)).toEqual(["Hello there"]);
  });

  it("builds nothing for no utterances", () => {
    const model = buildScriptModel(input([]));
    expect(model.turns).toEqual([]);
    expect(model.refs).toEqual([]);
  });
});

describe("scriptSelectionOf", () => {
  const model = buildScriptModel(input([HOST, GUEST]));

  it("maps a transcript range to window indices", () => {
    expect(
      scriptSelectionOf(model, {
        kind: "transcriptRange",
        trackId: "guest",
        sourceId: null,
        startWordIndex: 1,
        endWordIndex: 2,
      }),
    ).toEqual({ kind: "words", anchor: 4, head: 5 });
  });

  it("is null for other selections, a missing selection or an unknown word", () => {
    expect(scriptSelectionOf(model, null)).toBeNull();
    expect(
      scriptSelectionOf(model, { kind: "track", trackId: "host" }),
    ).toBeNull();
    expect(
      scriptSelectionOf(model, {
        kind: "transcriptRange",
        trackId: "host",
        sourceId: null,
        startWordIndex: 0,
        endWordIndex: 9,
      }),
    ).toBeNull();
  });
});

describe("wordsTargetOf", () => {
  const model = buildScriptModel(input([HOST, GUEST]));

  it("is a track range when every word is on one track", () => {
    expect(wordsTargetOf(model, { kind: "words", anchor: 2, head: 0 })).toEqual(
      {
        kind: "track",
        trackId: "host",
        sourceId: null,
        startWordIndex: 0,
        endWordIndex: 2,
      },
    );
  });

  it("is a time range over both tracks when the words cross tracks", () => {
    const target = wordsTargetOf(model, { kind: "words", anchor: 1, head: 4 });
    expect(target).toMatchObject({ kind: "time", start: 12.5 });
    expect(target?.kind === "time" && target.end).toBeCloseTo(20.9, 5);
    expect(target?.kind === "time" && target.trackIds).toEqual([
      "host",
      "guest",
    ]);
  });

  it("is a time range across tracks, and a track range on the untimed track alone", () => {
    const cutAway = utterance(
      "guest",
      "Anneke",
      [
        word("um", 5, 15, {
          mappable: false,
          timeline_start: null,
          timeline_end: null,
        }),
      ],
      { mappable: false },
    );
    const crossing = buildScriptModel(input([HOST, cutAway]));
    expect(
      wordsTargetOf(crossing, { kind: "words", anchor: 2, head: 3 }),
    ).toMatchObject({ kind: "time", start: 13, end: 13.4 });
    expect(
      wordsTargetOf(crossing, { kind: "words", anchor: 3, head: 3 }),
    ).toMatchObject({ kind: "track", trackId: "guest" });
  });

  it("is null for a window the model does not hold, or cross-track words with no time", () => {
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 9, head: 9 }),
    ).toBeNull();
    const untimed = buildScriptModel(
      input([
        utterance(
          "host",
          "Maya",
          [
            word("a", 0, 1, {
              mappable: false,
              timeline_start: null,
              timeline_end: null,
            }),
          ],
          { mappable: false },
        ),
        utterance(
          "guest",
          "Anneke",
          [
            word("b", 0, 2, {
              mappable: false,
              timeline_start: null,
              timeline_end: null,
            }),
          ],
          { mappable: false },
        ),
      ]),
    );
    expect(
      wordsTargetOf(untimed, { kind: "words", anchor: 0, head: 1 }),
    ).toBeNull();
  });
});

describe("words the project does not index", () => {
  const bare = (text: string) =>
    utterance("host", "Maya", [], { words: undefined, text });

  it("keys each bare row apart and never addresses it", () => {
    const model = buildScriptModel(input([bare("one"), bare("two")]));
    const keys = model.turns.flatMap((t) => t.words.map((w) => w.key));
    expect(new Set(keys).size).toBe(2);
    expect(
      model.indexOf({ trackId: "host", sourceId: null, wordIndex: 0 }),
    ).toBeUndefined();
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 0, head: 1 }),
    ).toBeNull();
  });

  it("does not let a bare row take the name of a real word", () => {
    const real = utterance("host", "Maya", [word("real", 0, 1)]);
    const model = buildScriptModel(input([real, bare("rest")]));
    expect(
      model.indexOf({ trackId: "host", sourceId: null, wordIndex: 0 }),
    ).toBe(0);
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 1, head: 1 }),
    ).toBeNull();
  });
});

describe("a word listed under two utterances", () => {
  const model = buildScriptModel(
    input([
      utterance("host", "Maya", [word("a", 1, 1), word("b", 2, 2)]),
      utterance("host", "Maya", [word("b", 2, 2), word("c", 3, 3)]),
    ]),
  );

  it("keeps both listings, with distinct keys", () => {
    const keys = model.turns.flatMap((t) => t.words.map((w) => w.key));
    expect(new Set(keys).size).toBe(4);
  });

  it("selects from the first listing of the start to the last listing of the end", () => {
    const ref = (wordIndex: number) => ({
      trackId: "host",
      sourceId: null,
      wordIndex,
    });
    expect(model.indexOf(ref(2))).toBe(1);
    expect(model.indexOf(ref(2), "last")).toBe(2);
    expect(
      scriptSelectionOf(model, {
        kind: "transcriptRange",
        trackId: "host",
        sourceId: null,
        startWordIndex: 1,
        endWordIndex: 2,
      }),
    ).toEqual({ kind: "words", anchor: 0, head: 2 });
  });
});

describe("cut words in a selection", () => {
  it("leaves them out of a range and gives nothing for a cut alone", () => {
    const boundary = {
      id: "b1",
      track_id: "host",
      timeline_join_sec: 12.4,
      has_cutaway: true,
      cutaway_source_start: 12.4,
      cutaway_source_end: 13,
      cutaway_word_ids: [
        {
          track_id: "host",
          source_id: null,
          word_index: -2,
          text: "uh",
          start: 12.4,
          end: 12.8,
        },
      ],
    } as unknown as EditBoundaryView;
    const model = buildScriptModel(
      input(
        [utterance("host", "Maya", [word("a", 0, 12), word("b", 1, 12.5)])],
        { boundaries: [boundary] },
      ),
    );
    expect(model.turns[0]?.words.map((w) => w.text)).toEqual(["a", "uh", "b"]);
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 0, head: 2 }),
    ).toMatchObject({
      kind: "track",
      startWordIndex: 0,
      endWordIndex: 1,
    });
    expect(
      wordsTargetOf(model, { kind: "words", anchor: 1, head: 1 }),
    ).toBeNull();
  });
});

describe("wordKey", () => {
  it("joins track, source and index", () => {
    expect(wordKey({ trackId: "t", sourceId: "s", wordIndex: 4 })).toBe(
      "t:s:4",
    );
    expect(wordKey({ trackId: "t", sourceId: null, wordIndex: 4 })).toBe(
      "t::4",
    );
  });
});

describe("speakerColorIndex", () => {
  it("wraps after the eighth colour and keeps a missing track on the first", () => {
    expect([0, 7, 8, 9, -1].map(speakerColorIndex)).toEqual([0, 7, 0, 1, 0]);
  });
});
