import { describe, expect, it } from "vitest";
import type { SessionTakes } from "../api/sessionTakes";
import {
  pendingEditView,
  sampleComment,
  sampleTrack,
  sessionSuggestionView,
} from "../test/fixtures";
import type {
  CombinedUtterance,
  PendingKind,
  PendingUnsureWord,
  TranscriptCheckStatus,
} from "../types/project";
import {
  CHECK_ID,
  checkEntryOf,
  commentEntriesOf,
  commentIdOf,
  commentItemId,
  editIdOf,
  pickupConfirmation,
  reviewCountOf,
  reviewEntriesOf,
  reviewIdOf,
  sessionEntriesOf,
  sessionIdOf,
  sessionItemId,
  sessionStartSec,
  suggestionTimesOf,
  takeToPlace,
  unsureEntriesOf,
  wordIdOf,
} from "./reviewItems";
import {
  decidedItems,
  filterCounts,
  fullOrder,
  type ReviewItem,
} from "./reviewQueueModel";

const itemOf = (over: Parameters<typeof pendingEditView>[0] = {}) => {
  const [entry] = reviewEntriesOf([pendingEditView(over)]);
  if (!entry) throw new Error("not listed");
  return entry.item;
};

describe("kind of a pending edit", () => {
  it.each([
    ["filler", "filler"],
    ["pause", "pause"],
    ["repeat", "repeat"],
    ["false-start", "false-start"],
    ["sound", "sound"],
    ["other", "suggestion"],
  ] satisfies [PendingKind, string][])("maps %s to %s", (wire, kind) => {
    expect(itemOf({ kind: wire }).kind).toBe(kind);
  });

  it.each([undefined, null, "mystery", "constructor", "__proto__", 7])(
    "gives suggestion for %s",
    (wire) => {
      expect(itemOf({ kind: wire as never }).kind).toBe("suggestion");
    },
  );
});

describe("speaker of an edit", () => {
  it("names the track's label, or the id when the track is unknown", () => {
    const [known, unknown] = reviewEntriesOf(
      [
        pendingEditView({ id: "a", track_id: "t1" }),
        pendingEditView({ id: "b", track_id: "t9" }),
      ],
      [{ id: "t1", label: "Host" }],
    );
    expect(known?.item.speaker).toEqual({ id: "t1", label: "Host" });
    expect(unknown?.item.speaker).toEqual({ id: "t9", label: "t9" });
  });
});

describe("reviewEntriesOf", () => {
  it("lists only edits that are not applied and need review", () => {
    const entries = reviewEntriesOf([
      pendingEditView({ id: "a" }),
      pendingEditView({ id: "b", applied: true }),
      pendingEditView({ id: "c", review_required: false }),
    ]);
    expect(entries.map((e) => e.item.id)).toEqual(["edit:a"]);
  });

  it("counts the same edits without building their entries", () => {
    const pending = [
      pendingEditView({ id: "a" }),
      pendingEditView({ id: "b", applied: true }),
      pendingEditView({ id: "c", review_required: false }),
      pendingEditView({ id: "d" }),
    ];
    expect(reviewCountOf(pending)).toBe(reviewEntriesOf(pending).length);
    expect(reviewCountOf(pending)).toBe(2);
  });

  it("leaves a cut over an unsure word out of a guest's count only", () => {
    const unsure = pendingEditView({
      id: "u",
      unsure_words: [
        {
          track_id: "t",
          source_id: null,
          word_index: 1,
          text: "maybe",
          confidence: 0.4,
        },
      ],
    });
    const pending = [pendingEditView({ id: "a" }), unsure];
    expect(reviewCountOf(pending)).toBe(2);
    expect(reviewCountOf(pending, true)).toBe(1);
  });

  it("counts overlapping spans inside one edit once", () => {
    const item = itemOf({
      timeline_spans: [
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ],
    });
    expect(item.savedSeconds).toBe(3);
  });

  it("keeps the removed ranges so overlapping edits can be counted once", () => {
    const item = itemOf({
      timeline_spans: [
        { start: 4, end: 5 },
        { start: 7, end: 7.5 },
        { start: 9, end: 9 },
      ],
    });
    expect(item.spans).toEqual([
      [4, 5],
      [7, 7.5],
    ]);
  });

  it.each([
    ["a mute", { type: "mute" }],
    ["a track-scope cut", { scope: "track" }],
    ["an exact-range cut", { exact_range: { start: 1, end: 2 } }],
  ] as const)(
    "saves nothing for %s, which leaves the timeline length alone",
    (_n, patch) => {
      const item = itemOf({
        ...patch,
        timeline_spans: [{ start: 1, end: 2 }],
      } as never);
      expect(item.savedSeconds).toBe(0);
      expect(item.spans).toBeUndefined();
    },
  );

  it("sums every span for savedSeconds", () => {
    const item = itemOf({
      timeline_spans: [
        { start: 2, end: 3 },
        { start: 10, end: 10.5 },
      ],
    });
    expect(item.savedSeconds).toBe(1.5);
  });

  it.each([
    ["lower", 0],
    ["leave", 0],
    ["cut", 1],
    ["shorten", 1],
  ] as const)("saves %s seconds for the %s action", (action, saved) => {
    expect(itemOf({ suggested_action: action }).savedSeconds).toBe(saved);
  });

  it("puts an unplaced edit at Infinity, last in the queue", () => {
    const placed = itemOf({ id: "p", timeline_start: 5 });
    const unplaced = itemOf({ id: "u", timeline_start: null });
    expect(unplaced.at).toBe(Number.POSITIVE_INFINITY);
    const order = fullOrder([unplaced, placed] satisfies ReviewItem[]);
    expect(order.map((i) => i.id)).toEqual(["edit:p", "edit:u"]);
  });

  it("carries no one-by-one flag: risky and harsh cuts group like the rest", () => {
    const risky = itemOf({
      review_required: true,
      harsh: true,
      listen_one_by_one: true,
      join_risk: { verdict: "review" } as never,
    });
    expect(risky).not.toHaveProperty("oneByOne");
  });

  it("names why a cut needs a listen, riskiest flag first, and leaves clean cuts unflagged", () => {
    const risk = (over: Parameters<typeof itemOf>[0]) => itemOf(over).risk;
    expect(risk({})).toBeUndefined();
    expect(risk({ join_risk: { verdict: "pass" } })).toBeUndefined();
    expect(risk({ listen_one_by_one: true })).toEqual({
      rank: 1,
      reason: "Listen first",
    });
    expect(risk({ join_risk: { verdict: "review" } })).toEqual({
      rank: 2,
      reason: "Join needs a listen",
    });
    expect(risk({ harsh: true, join_risk: { verdict: "review" } })).toEqual({
      rank: 3,
      reason: "Join may be audible",
    });
    expect(risk({ join_risk: { verdict: "fail" } })?.rank).toBe(3);
  });

  it("passes the table action through", () => {
    expect(itemOf({ suggested_action: "leave" }).suggested).toBe("leave");
  });

  it("never sets unsure or blocked, and ignores sound_kind and reason", () => {
    const item = itemOf({
      kind: "filler",
      sound_kind: "laugh",
      reason: "tighten:sound",
    });
    expect(item).toEqual({
      id: "edit:pending-1",
      kind: "filler",
      at: 2,
      savedSeconds: 1,
      spans: [[2, 3]],
      suggested: undefined,
      speaker: { id: "mira-voice", label: "mira-voice" },
    });
  });

  it("gives minimal row and card content from the label", () => {
    const [entry] = reviewEntriesOf([pendingEditView({ label: "Long pause" })]);
    expect(entry?.content.row).toEqual({
      snippet: "Long pause",
      time: "0:02",
      value: "1.0 s",
    });
    expect(entry?.content.card).toEqual({
      title: "Long pause",
      time: "0:02",
      change: { start: 2, end: 3 },
    });
    expect(
      reviewEntriesOf([pendingEditView({ label: null })])[0]?.content.card
        .title,
    ).toBe("Suggestion");
  });

  it("uses the first eligible unsure word and keeps the proposal count", () => {
    const pending = pendingEditView({
      id: "mixed",
      track_id: "host",
      track_ids: ["host"],
      unsure_words: [
        {
          track_id: "host",
          source_id: "source",
          word_index: 1,
          text: "cut",
          confidence: 0.4,
        },
        {
          track_id: "host",
          source_id: "source",
          word_index: 2,
          text: "playable",
          confidence: 0.4,
        },
        {
          track_id: "host",
          source_id: "source",
          word_index: 3,
          text: "also cut",
          confidence: 0.4,
        },
      ],
    });
    const target = (trackId: string, sourceId: string, wordIndex: number) => ({
      trackId,
      sourceId,
      wordIndex,
      text: "playable",
      at: 4,
      endSec: 5,
    });
    const targets = new Map([
      [wordIdOf("host", "source", 2), target("host", "source", 2)],
      [wordIdOf("guest", "source", 1), target("guest", "source", 1)],
      [wordIdOf("host", "other", 1), target("host", "other", 1)],
      [wordIdOf("host", "source", 9), target("host", "source", 9)],
    ]);
    const [entry] = reviewEntriesOf([pending], [], targets);
    expect(entry?.item.unsure).toBe(true);
    expect(entry?.content.card.unsure).toEqual({
      word: "playable",
      guess: "playable",
      id: wordIdOf("host", "source", 2),
      editorIdentity: targets.get(wordIdOf("host", "source", 2)),
      step: { index: 1, total: 1 },
    });
    expect(reviewCountOf([pending])).toBe(1);
  });

  it("keeps the raw unsure guard when every proposed word is cut away", () => {
    const pending = pendingEditView({
      unsure_words: [
        {
          track_id: "host",
          source_id: null,
          word_index: 1,
          text: "cut",
          confidence: 0.4,
        },
      ],
    });

    const [raw, entry] = [
      reviewEntriesOf([pending], [], undefined)[0],
      reviewEntriesOf([pending], [], new Map())[0],
    ];

    expect(raw?.item.unsure).toBe(true);
    expect(raw?.content.card.unsure).toMatchObject({
      id: wordIdOf("host", null, 1),
    });
    expect(entry?.item.unsure).toBe(true);
    expect(entry?.content.card.unsure).toBeUndefined();
    expect(reviewCountOf([pending])).toBe(1);
  });

  it("keeps raw unsure fallback when eligibility is unknown", () => {
    const pending = pendingEditView({
      unsure_words: [
        {
          track_id: "host",
          source_id: null,
          word_index: 1,
          text: "maybe",
          confidence: 0.4,
        },
      ],
    });

    const [entry] = reviewEntriesOf([pending]);

    expect(entry?.item.unsure).toBe(true);
    expect(entry?.content.card.unsure).toMatchObject({
      word: "maybe",
      id: wordIdOf("host", null, 1),
      step: { index: 1, total: 1 },
    });
  });
});

describe("review ids", () => {
  it("round-trips an edit id and rejects a foreign id", () => {
    expect(editIdOf(reviewIdOf("e-9"))).toBe("e-9");
    expect(editIdOf("c1")).toBeNull();
  });
});

describe("reviewEntriesOf on odd payloads", () => {
  it("tolerates missing spans and ignores negative or non-finite lengths", () => {
    const none = { timeline_spans: undefined } as never;
    expect(itemOf(none).savedSeconds).toBe(0);
    const odd = itemOf({
      timeline_spans: [
        { start: 3, end: 1 },
        { start: 0, end: Number.POSITIVE_INFINITY },
        { start: 0, end: Number.NaN },
        { start: 1, end: 1.5 },
      ],
    });
    expect(odd.savedSeconds).toBe(0.5);
  });

  it.each([Number.NaN, undefined, Number.NEGATIVE_INFINITY])(
    "puts an unplaced start (%s) last",
    (start) => {
      const item = itemOf({ timeline_start: start as never });
      expect(item.at).toBe(Number.POSITIVE_INFINITY);
    },
  );

  it("fails closed on an unknown suggested action", () => {
    const item = itemOf({ suggested_action: "mute" as never });
    expect(item.suggested).toBe("leave");
    expect(item.savedSeconds).toBe(0);
  });
});

describe("card content from the edit", () => {
  const cardOf = (over: Parameters<typeof pendingEditView>[0]) =>
    reviewEntriesOf([pendingEditView(over)])[0]?.content.card;

  it("frames the change by the timeline range and never sets a waveform", () => {
    const card = cardOf({ timeline_start: 4, timeline_end: 6.5 });
    expect(card?.change).toEqual({ start: 4, end: 6.5 });
    expect(card?.waveform).toBeUndefined();
  });

  it.each([
    { timeline_start: null },
    { timeline_end: null },
    { timeline_end: Number.NaN },
  ])("has no change for %o", (over) => {
    expect(cardOf(over as never)?.change).toBeUndefined();
  });

  it("carries why when the edit has one", () => {
    expect(cardOf({ why: "Jon restarts." })?.why).toBe("Jon restarts.");
    expect(cardOf({ why: null })).not.toHaveProperty("why");
  });
});

describe("checkEntryOf", () => {
  const status = (
    over: Partial<TranscriptCheckStatus>,
  ): TranscriptCheckStatus => ({
    status: "pending",
    clear: false,
    stale: false,
    mode: "require",
    fingerprint: "fp",
    source: null,
    notes: "",
    updated_at: null,
    hint: null,
    low_confidence_words: 3,
    low_confidence_threshold: 0.5,
    ...over,
  });

  it.each([
    { clear: true },
    { status: "done" as const },
    { status: "waived" as const },
  ])("is null for %o", (over) => {
    expect(checkEntryOf(status(over), null)).toBeNull();
  });

  it("is the transcript check, first in its group, with no edit id", () => {
    const entry = checkEntryOf(status({}), 3);
    expect(entry?.item).toEqual({
      id: CHECK_ID,
      kind: "check",
      at: Number.NEGATIVE_INFINITY,
      savedSeconds: 0,
      transcript: true,
    });
    expect(editIdOf(CHECK_ID)).toBeNull();
    expect(entry?.content.check?.detail).toBe("3 unsure words");
  });

  it("words the detail as the count even when the server sends a hint", () => {
    expect(
      checkEntryOf(status({ hint: "Run the CLI." }), 3)?.content.check?.detail,
    ).toBe("3 unsure words");
  });

  it("keeps the server check open without counting unmappable saved words", () => {
    const entry = checkEntryOf(status({ low_confidence_words: 1 }), 0);
    expect(entry?.item.transcript).toBe(true);
    expect(entry?.content.check?.detail).toBeUndefined();
    expect(entry?.content.card.why).toBeUndefined();
  });

  it("omits the numeric copy until the active word count is known", () => {
    expect(
      checkEntryOf(status({ low_confidence_words: 3 }), null)?.content.check,
    ).toMatchObject({ title: "Check the transcript before cutting" });
    expect(checkEntryOf(status({}), null)?.content.card.why).toBeUndefined();
  });
});

describe("unsureEntriesOf", () => {
  const word = (index: number, text: string): PendingUnsureWord => ({
    track_id: "host",
    source_id: null,
    word_index: index,
    text,
    confidence: 0.4,
  });
  const cut = (id: string, start: number | null, words = [word(1, "gnu")]) =>
    pendingEditView({
      id,
      label: `cut ${id}`,
      review_required: true,
      timeline_start: start as never,
      unsure_words: words,
    });
  const utterance = (words: object[]) =>
    [
      {
        track_id: "host",
        speaker: "Jon",
        start: 0,
        end: 9,
        text: "",
        mappable: true,
        words,
      },
    ] as never;

  it("stops display context at suppressed and edge-suppressed words", () => {
    const typedUtterance = (
      overrides: Partial<CombinedUtterance> = {},
    ): CombinedUtterance => ({
      track_id: "host",
      speaker: "Jon",
      start: 0,
      end: 9,
      text: "",
      mappable: true,
      words: [
        {
          text: "ordinary-left",
          start: 1,
          end: 1.2,
          word_index: 0,
          mappable: true,
        },
        {
          text: "edge-left",
          start: 2,
          end: 2.2,
          word_index: 1,
          mappable: true,
          suppressed: true,
        },
        {
          text: "focus",
          start: 3,
          end: 3.2,
          word_index: 2,
          mappable: true,
          unsure: true,
        },
        {
          text: "edge-right",
          start: 4,
          end: 4.2,
          word_index: 3,
          mappable: true,
          suppressed: true,
        },
        {
          text: "ordinary-right",
          start: 5,
          end: 5.2,
          word_index: 4,
          mappable: true,
        },
      ],
      ...overrides,
    });
    const mappedEdge = typedUtterance({ edge_suppressed_word_indices: [1, 3] });
    const result = unsureEntriesOf([], [mappedEdge]);
    const target = result.targets.get("word:host::2");
    const [standalone] = result.entries;
    const [proposal] = reviewEntriesOf(
      [pendingEditView({ unsure_words: [word(2, "focus")] })],
      [],
      result.targets,
    );

    expect(target?.context).toEqual({ before: [], focus: "focus", after: [] });
    expect(standalone?.content.card.unsure).toMatchObject({
      word: "focus",
      context: { before: [], focus: "focus", after: [] },
    });
    expect(proposal?.content.card.unsure).toMatchObject({
      word: "focus",
      step: { index: 1, total: 1 },
      context: { before: [], focus: "focus", after: [] },
    });
    expect(standalone?.item.id).toBe("word:host::2");
    expect(proposal?.item.id).toBe("edit:pending-1");

    const metadataOnly = structuredClone(mappedEdge);
    for (const word of metadataOnly.words ?? []) delete word.suppressed;
    expect(
      unsureEntriesOf([], [metadataOnly]).targets.get("word:host::2")?.context,
    ).toEqual({ before: [], focus: "focus", after: [] });
    expect(
      unsureEntriesOf([], [typedUtterance()]).targets.get("word:host::2")
        ?.context,
    ).toEqual({ before: [], focus: "focus", after: [] });

    const suppressedFocus = typedUtterance({
      words: [
        {
          text: "suppressed-focus",
          start: 2,
          end: 2.2,
          word_index: 2,
          mappable: true,
          suppressed: true,
          unsure: true,
        },
        { text: "next", start: 3, end: 3.2, word_index: 3, mappable: true },
      ],
    });
    const retained = unsureEntriesOf(
      [cut("kept", 20, [word(2, "suppressed-focus")])],
      [suppressedFocus],
    );
    expect(retained.targets.has("word:host::2")).toBe(true);
    expect(retained.targets.get("word:host::2")).not.toHaveProperty("context");
    expect(retained.entries.map((entry) => entry.item.id)).toEqual([
      "word:host::2",
    ]);

    const suppressedOnly = typedUtterance({
      suppressed_only: true,
      words: [
        {
          text: "row-focus",
          start: 2,
          end: 2.2,
          word_index: 2,
          mappable: true,
          unsure: true,
        },
        {
          text: "row-neighbor",
          start: 3,
          end: 3.2,
          word_index: 3,
          mappable: true,
        },
      ],
    });
    const rowTarget = unsureEntriesOf(
      [cut("suppressed-row", 20, [word(2, "row-focus")])],
      [suppressedOnly],
    ).targets.get("word:host::2");
    expect(rowTarget).toMatchObject({ trackId: "host", wordIndex: 2 });
    expect(rowTarget).not.toHaveProperty("context");
  });

  it("lists a shared word once, adds transcript-only words, and orders by time", () => {
    const { entries, targets } = unsureEntriesOf(
      [cut("a", 20), cut("b", 30), cut("c", null, [word(2, "orc")])],
      utterance([
        {
          text: "uncle",
          start: 1,
          end: 2,
          timeline_start: 1,
          timeline_end: 1.5,
          word_index: 0,
          unsure: true,
        },
        {
          text: "gnu",
          start: 5,
          end: 6,
          timeline_start: 5,
          timeline_end: 5.5,
          word_index: 1,
          unsure: true,
        },
        { text: "fine", start: 7, end: 8, timeline_start: 7, word_index: 3 },
      ]),
    );
    expect(entries.map((e) => [e.item.id, e.item.at])).toEqual([
      ["word:host::0", 1],
      ["word:host::1", 5],
      ["word:host::2", Number.POSITIVE_INFINITY],
    ]);
    expect(entries[1]?.content.card).toMatchObject({
      title: "Is this “gnu”?",
      why: "Inside “cut a”",
      unsure: { word: "gnu", guess: "gnu" },
    });
    expect(entries[2]?.content.row.time).toBe("Unplaced");
    expect(targets.get("word:host::1")).toMatchObject({
      trackId: "host",
      sourceId: null,
      wordIndex: 1,
      endSec: 5.5,
    });
  });

  it("omits context when the proposal word differs from its indexed target", () => {
    const pending = [cut("proposal", 20, [word(2, "canonical")])];
    const transcript = utterance([
      { text: "before", start: 1, end: 1.2, word_index: 1, mappable: true },
      {
        text: "indexed",
        start: 2,
        end: 2.2,
        word_index: 2,
        confidence: 0.4,
        unsure: true,
        mappable: true,
      },
      { text: "after", start: 3, end: 3.2, word_index: 3, mappable: true },
    ]);
    const { entries, targets } = unsureEntriesOf(pending, transcript);
    const [standalone] = entries;
    const [proposal] = reviewEntriesOf(pending, [], targets);

    expect(standalone?.item.id).toBe("word:host::2");
    expect(standalone?.content.card.unsure).toMatchObject({
      word: "indexed",
      guess: "indexed",
      context: { before: ["before"], focus: "indexed", after: ["after"] },
    });
    expect(proposal?.item.id).toBe("edit:proposal");
    expect(proposal?.content.card.unsure).toMatchObject({
      word: "canonical",
      guess: "canonical",
      id: "word:host::2",
      editorIdentity: JSON.stringify(["host", null, 2, 2.2, "indexed"]),
      step: { index: 1, total: 1 },
    });
    expect(proposal?.content.card.unsure).not.toHaveProperty("context");

    const matchingPending = [cut("matching", 20, [word(2, "indexed")])];
    const matching = unsureEntriesOf(matchingPending, transcript);
    const [matchingProposal] = reviewEntriesOf(
      matchingPending,
      [],
      matching.targets,
    );
    expect(matchingProposal?.content.card.unsure).toMatchObject({
      word: "indexed",
      context: { before: ["before"], focus: "indexed", after: ["after"] },
    });
  });

  it("omits transcript context that differs from a pending-only target", () => {
    const pending = [cut("pending-only", 20, [word(2, "old")])];
    const transcript = utterance([
      { text: "before", start: 1, end: 1.2, word_index: 1, mappable: true },
      {
        text: "new",
        start: 2,
        end: 2.2,
        word_index: 2,
        confidence: 0.99,
        mappable: true,
      },
      { text: "after", start: 3, end: 3.2, word_index: 3, mappable: true },
    ]);
    const { entries, targets } = unsureEntriesOf(pending, transcript);
    const [standalone] = entries;
    const [proposal] = reviewEntriesOf(pending, [], targets);

    expect(targets.get("word:host::2")).toMatchObject({
      trackId: "host",
      sourceId: null,
      wordIndex: 2,
      text: "old",
      editorIdentity: JSON.stringify(["host", null, 2, 2.2, "new"]),
    });
    expect(targets.get("word:host::2")).not.toHaveProperty("context");
    expect(standalone?.content.card.unsure).toEqual({
      word: "old",
      guess: "old",
      editorIdentity: JSON.stringify(["host", null, 2, 2.2, "new"]),
    });
    expect(standalone?.content.card.unsure).not.toHaveProperty("context");
    expect(proposal?.item.id).toBe("edit:pending-only");
    expect(proposal?.content.card.unsure).toMatchObject({
      word: "old",
      guess: "old",
      id: "word:host::2",
      editorIdentity: JSON.stringify(["host", null, 2, 2.2, "new"]),
      step: { index: 1, total: 1 },
    });
    expect(proposal?.content.card.unsure).not.toHaveProperty("context");

    const matchingPending = [
      cut("matching-pending-only", 20, [word(2, "new")]),
    ];
    const matching = unsureEntriesOf(matchingPending, transcript);
    const [matchingProposal] = reviewEntriesOf(
      matchingPending,
      [],
      matching.targets,
    );
    expect(matching.targets.get("word:host::2")?.context).toEqual({
      before: ["before"],
      focus: "new",
      after: ["after"],
    });
    expect(matchingProposal?.content.card.unsure).toMatchObject({
      word: "new",
      context: { before: ["before"], focus: "new", after: ["after"] },
    });
  });

  it("places a cut-only word at its own start, not the cut's, when the transcript has it", () => {
    const { entries } = unsureEntriesOf(
      [cut("a", 20)],
      utterance([
        { text: "gnu", start: 5, end: 6, timeline_start: 5, word_index: 1 },
      ]),
    );
    expect(entries.map((e) => e.item.at)).toEqual([5]);
  });

  it("distinguishes identical guesses at a reused ordinal and keeps identity across timeline moves", () => {
    const projection = (start: number, at: number, text = "gnu") => {
      const pending = [cut("a", 2, [word(1, text)])];
      const { entries, targets } = unsureEntriesOf(
        pending,
        utterance([
          {
            text,
            start,
            end: start + 0.1,
            timeline_start: at,
            timeline_end: at + 0.1,
            word_index: 1,
            unsure: true,
            mappable: true,
          },
        ]),
      );
      return {
        id: entries[0]?.item.id,
        standalone: entries[0]?.content.card.unsure,
        proposal: reviewEntriesOf(pending, [], targets)[0]?.content.card.unsure,
      };
    };
    const original = projection(2.33, 2.13);
    const moved = projection(2.33, 7.13);
    const restored = projection(2.01, 2.01);
    expect([original.id, moved.id, restored.id]).toEqual(
      Array(3).fill("word:host::1"),
    );
    expect(original.standalone).toMatchObject({ word: "gnu" });
    expect(original.proposal).toMatchObject(original.standalone ?? {});
    expect(moved).toEqual(original);
    expect(restored.standalone).not.toEqual(original.standalone);
    expect(restored.proposal).not.toEqual(original.proposal);
    expect(projection(2.33, 2.13, "corrected").proposal).toHaveProperty(
      "editorIdentity",
      JSON.stringify(["host", null, 2.33, 2.43, "corrected"]),
    );
  });

  it("falls back to the cut's start when the transcript lacks the word", () => {
    const pending = [cut("a", 20)];
    const { entries, targets } = unsureEntriesOf(pending, utterance([]));
    expect(entries.map((e) => e.item.at)).toEqual([20]);
    const id = "word:host::1";
    const target = targets.get(id);
    expect(entries[0]?.content.card.unsure).toMatchObject({ word: "gnu" });
    expect(entries[0]?.content.card.unsure).toHaveProperty(
      "editorIdentity",
      target,
    );
    expect(
      reviewEntriesOf(pending, [], targets)[0]?.content.card.unsure,
    ).toHaveProperty("editorIdentity", target);
  });

  it("does not reinsert a known unmapped transcript word from a pending cut", () => {
    const { entries, targets } = unsureEntriesOf(
      [cut("a", 20, [word(1, "maybe"), word(2, "perhaps")])],
      utterance([
        {
          text: "maybe",
          start: 5,
          end: 5.2,
          word_index: 1,
          confidence: 0.4,
          unsure: true,
          mappable: false,
          timeline_start: null,
          timeline_end: null,
        },
        {
          text: "perhaps",
          start: 5.2,
          end: 5.4,
          word_index: 2,
          confidence: 0.4,
          unsure: true,
          mappable: true,
          timeline_start: 9,
          timeline_end: 9.2,
        },
      ]),
    );

    expect(entries.map((entry) => entry.item.id)).toEqual(["word:host::2"]);
    expect(entries[0]?.item.at).toBe(9);
    expect(targets.has("word:host::1")).toBe(false);
    expect(targets.get("word:host::2")).toMatchObject({
      text: "perhaps",
      at: 9,
      endSec: 9.2,
    });
  });

  it("matches pending timing targets by source and preserves a null source fallback", () => {
    const pending = [
      cut("override", 20, [{ ...word(1, "override"), source_id: "source-b" }]),
      cut("fallback", 30, [{ ...word(2, "fallback"), source_id: "source-a" }]),
    ];
    const utterances = [
      {
        track_id: "host",
        source_id: "source-a",
        speaker: "Jon",
        start: 0,
        end: 9,
        text: "override fallback sure",
        mappable: true,
        words: [
          {
            text: "override",
            start: 2,
            end: 2.2,
            word_index: 1,
            unsure: true,
            mappable: true,
            timeline_start: 6,
            timing_target: {
              track_id: "host",
              source_id: "source-b",
              word_index: 1,
            },
          },
          {
            text: "fallback",
            start: 3,
            end: 3.2,
            word_index: 2,
            unsure: true,
            mappable: true,
            timeline_start: 7,
            timing_target: {
              track_id: "host",
              source_id: null,
              word_index: 2,
            },
          },
          {
            text: "sure",
            start: 4,
            end: 4.2,
            word_index: 3,
            unsure: false,
            mappable: true,
            timeline_start: 8,
          },
        ],
      },
    ] satisfies CombinedUtterance[];
    const { entries, targets } = unsureEntriesOf(pending, utterances);

    expect(entries.map((entry) => [entry.item.id, entry.item.at])).toEqual([
      ["word:host:source-b:1", 6],
      ["word:host:source-a:2", 7],
    ]);
    expect(targets.get("word:host:source-b:1")).toMatchObject({
      sourceId: "source-b",
      at: 6,
    });
    expect(entries.map((entry) => entry.content.card.unsure)).toMatchObject([
      {
        editorIdentity: JSON.stringify([
          "host",
          "source-b",
          2,
          2.2,
          "override",
        ]),
      },
      { editorIdentity: JSON.stringify(["host", null, 3, 3.2, "fallback"]) },
    ]);

    const afterCut = utterances.map((utterance) => ({
      ...utterance,
      words: utterance.words.map((word) =>
        word.unsure
          ? {
              ...word,
              mappable: false,
              timeline_start: null,
              timeline_end: null,
            }
          : word,
      ),
    }));
    const cutEntries = unsureEntriesOf(pending, afterCut);
    expect(cutEntries.entries.map((entry) => entry.item.id)).toEqual([]);
    expect(cutEntries.targets.size).toBe(0);
  });

  it("does not let a known unmapped word veto another track with the same index", () => {
    const pending = [
      cut("host-cut", 20, [{ ...word(1, "host"), track_id: "host" }]),
      cut("guest-cut", 30, [{ ...word(1, "guest"), track_id: "guest" }]),
    ];
    const utterances: CombinedUtterance[] = [
      {
        track_id: "host",
        source_id: null,
        speaker: "Jon",
        start: 0,
        end: 9,
        text: "",
        mappable: true,
        words: [
          {
            text: "host",
            start: 2,
            end: 2.2,
            word_index: 1,
            unsure: true,
            mappable: false,
            timeline_start: null,
          },
        ],
      },
      {
        track_id: "guest",
        source_id: null,
        speaker: "Rosa",
        start: 0,
        end: 9,
        text: "",
        mappable: true,
        words: [
          {
            text: "guest",
            start: 3,
            end: 3.2,
            word_index: 1,
            unsure: true,
            mappable: true,
            timeline_start: 8,
          },
        ],
      },
    ];

    const { entries } = unsureEntriesOf(pending, utterances);

    expect(entries.map((entry) => [entry.item.id, entry.item.at])).toEqual([
      ["word:guest::1", 8],
    ]);
  });

  it("puts a word with no placement last, and ignores applied cuts", () => {
    const { entries } = unsureEntriesOf(
      [cut("a", null), { ...cut("b", 3, [word(7, "no")]), applied: true }],
      [],
    );
    expect(
      entries.map((e) => [e.item.id, e.item.at, e.content.row.time]),
    ).toEqual([["word:host::1", Number.POSITIVE_INFINITY, "Unplaced"]]);
  });

  it("marks a cut unsure and points its card at the first word", () => {
    const [entry] = reviewEntriesOf([
      cut("a", 2, [word(4, "uncle"), word(5, "gnu")]),
    ]);
    expect(entry?.item.unsure).toBe(true);
    expect(entry?.content.card.unsure).toEqual({
      word: "uncle",
      guess: "uncle",
      id: "word:host::4",
      step: { index: 1, total: 2 },
    });
  });

  it("builds a bounded context for the exact repeated occurrence", () => {
    const words = ["we", "said", "go", "go", "again", "today"].map(
      (text, index) => ({
        text,
        start: index,
        end: index + 0.5,
        word_index: index,
        unsure: index === 3,
        mappable: true,
      }),
    );
    const { entries, targets } = unsureEntriesOf([], utterance(words));

    expect(targets.get("word:host::3")).toMatchObject({
      context: {
        before: ["we", "said", "go"],
        focus: "go",
        after: ["again", "today"],
      },
    });
    expect(
      entries.find((entry) => entry.item.id === "word:host::3")?.content.card
        .unsure,
    ).toMatchObject({
      context: {
        before: ["we", "said", "go"],
        focus: "go",
        after: ["again", "today"],
      },
    });
  });

  it("uses track, effective source, and timing-source override to isolate the occurrence", () => {
    const makeUtterance = (
      track_id: string,
      source_id: string | null,
      text: string,
      timingSource?: string | null,
    ): CombinedUtterance => ({
      track_id,
      source_id,
      speaker: track_id,
      start: 0,
      end: 9,
      text: "",
      words: [
        {
          text: `${text}-before`,
          start: 1,
          end: 1.2,
          word_index: 1,
          mappable: true,
          ...(timingSource === undefined
            ? {}
            : {
                timing_target: {
                  track_id,
                  source_id: timingSource,
                  word_index: 1,
                },
              }),
        },
        {
          text,
          start: 2,
          end: 2.2,
          word_index: 2,
          unsure: false,
          mappable: true,
          ...(timingSource === undefined
            ? {}
            : {
                timing_target: {
                  track_id,
                  source_id: timingSource,
                  word_index: 2,
                },
              }),
        },
        {
          text: `${text}-after`,
          start: 3,
          end: 3.2,
          word_index: 3,
          mappable: true,
          ...(timingSource === undefined
            ? {}
            : {
                timing_target: {
                  track_id,
                  source_id: timingSource,
                  word_index: 3,
                },
              }),
        },
      ],
    });
    const utterances = [
      makeUtterance("host", "source-a", "wrong-take"),
      makeUtterance("host", "source-a", "override-take", "source-b"),
      makeUtterance("guest", "source-b", "wrong-track"),
      makeUtterance("host", null, "null-source"),
    ];
    const targets = [
      { ...word(2, "override-take"), source_id: "source-b" },
      { ...word(2, "null-source"), source_id: null },
    ];
    const result = unsureEntriesOf([cut("selected", 20, targets)], utterances);

    expect(result.targets.get("word:host:source-b:2")).toMatchObject({
      context: {
        before: ["override-take-before"],
        focus: "override-take",
        after: ["override-take-after"],
      },
    });
    expect(result.targets.get("word:host::2")).toMatchObject({
      context: {
        before: ["null-source-before"],
        focus: "null-source",
        after: ["null-source-after"],
      },
    });
    expect(result.entries.map((entry) => entry.item.id)).toEqual([
      "word:host:source-b:2",
      "word:host::2",
    ]);
  });

  it("clamps each side to four words and stops at unusable or discontinuous neighbors", () => {
    const words = Array.from({ length: 12 }, (_, index) => ({
      text: `w${index},`,
      start: index,
      end: index + 0.5,
      word_index: index,
      unsure: index === 5,
      mappable: true,
    }));
    const utterances = utterance(words);
    const middle = unsureEntriesOf([], utterances).targets.get("word:host::5");
    const first = unsureEntriesOf(
      [],
      utterance(
        words.map((word, index) => ({
          ...word,
          unsure: index === 0,
        })),
      ),
    ).targets.get("word:host::0");
    const barrierWords = words.map((word, index) =>
      index === 4 ? { ...word, mappable: false } : word,
    );
    const stopped = unsureEntriesOf([], utterance(barrierWords)).targets.get(
      "word:host::5",
    );

    expect(middle).toMatchObject({
      context: {
        before: ["w1,", "w2,", "w3,", "w4,"],
        focus: "w5,",
        after: ["w6,", "w7,", "w8,", "w9,"],
      },
    });
    expect(first).toMatchObject({
      context: {
        before: [],
        focus: "w0,",
        after: ["w1,", "w2,", "w3,", "w4,"],
      },
    });
    expect(stopped).toMatchObject({
      context: {
        before: [],
        focus: "w5,",
        after: ["w6,", "w7,", "w8,", "w9,"],
      },
    });
  });

  it("omits absent or conflicting context without removing the target or its card", () => {
    const missing = unsureEntriesOf([cut("missing", 20)], utterance([]));
    const synthetic = unsureEntriesOf(
      [cut("synthetic", 20)],
      [
        {
          track_id: "host",
          source_id: null,
          speaker: "Jon",
          start: 0,
          end: 9,
          text: "we said gnu now",
        },
      ],
    );
    const duplicate = [
      ...utterance([
        { text: "before-a", start: 1, end: 1.2, word_index: 1, mappable: true },
        {
          text: "gnu",
          start: 2,
          end: 2.2,
          word_index: 2,
          unsure: true,
          mappable: true,
        },
        { text: "after-a", start: 3, end: 3.2, word_index: 3, mappable: true },
      ]),
      ...utterance([
        { text: "before-b", start: 1, end: 1.2, word_index: 1, mappable: true },
        {
          text: "gnu",
          start: 2,
          end: 2.2,
          word_index: 2,
          unsure: true,
          mappable: true,
        },
        { text: "after-b", start: 3, end: 3.2, word_index: 3, mappable: true },
      ]),
    ];
    const ambiguous = unsureEntriesOf([], duplicate);
    const consistent = unsureEntriesOf(
      [],
      [
        ...utterance([
          { text: "before", start: 1, end: 1.2, word_index: 1, mappable: true },
          {
            text: "gnu",
            start: 2,
            end: 2.2,
            word_index: 2,
            unsure: true,
            mappable: true,
          },
          { text: "after", start: 3, end: 3.2, word_index: 3, mappable: true },
        ]),
        ...utterance([
          { text: "before", start: 1, end: 1.2, word_index: 1, mappable: true },
          {
            text: "gnu",
            start: 2,
            end: 2.2,
            word_index: 2,
            unsure: true,
            mappable: true,
          },
          { text: "after", start: 3, end: 3.2, word_index: 3, mappable: true },
        ]),
      ],
    );

    expect(missing.entries).toHaveLength(1);
    expect(missing.entries[0]?.content.card.unsure).toEqual({
      word: "gnu",
      guess: "gnu",
      editorIdentity: missing.targets.get("word:host::1"),
    });
    expect(missing.targets.has("word:host::1")).toBe(true);
    expect(synthetic.entries).toHaveLength(1);
    expect(synthetic.targets.get("word:host::1")).not.toHaveProperty("context");
    expect(ambiguous.entries).toHaveLength(1);
    expect(ambiguous.targets.get("word:host::2")).not.toHaveProperty("context");
    expect(consistent.targets.get("word:host::2")).toMatchObject({
      context: { before: ["before"], focus: "gnu", after: ["after"] },
    });
  });

  it("adds the chosen target context to a proposal without changing its selection step", () => {
    const utterances = utterance([
      {
        text: "first-before",
        start: 1,
        end: 1.2,
        word_index: 1,
        mappable: true,
      },
      {
        text: "first",
        start: 2,
        end: 2.2,
        word_index: 2,
        unsure: true,
        mappable: true,
      },
      {
        text: "first-after",
        start: 3,
        end: 3.2,
        word_index: 3,
        mappable: true,
      },
      {
        text: "second-before",
        start: 4,
        end: 4.2,
        word_index: 4,
        mappable: true,
      },
      {
        text: "second",
        start: 5,
        end: 5.2,
        word_index: 5,
        unsure: true,
        mappable: true,
      },
      {
        text: "second-after",
        start: 6,
        end: 6.2,
        word_index: 6,
        mappable: true,
      },
    ]);
    const { targets } = unsureEntriesOf([], utterances);
    const edit = pendingEditView({
      unsure_words: [word(5, "second"), word(2, "first")],
    });
    const [proposal] = reviewEntriesOf([edit], [], targets);

    expect(proposal?.content.card.unsure).toMatchObject({
      word: "second",
      id: "word:host::5",
      step: { index: 1, total: 2 },
      context: {
        before: ["first-before", "first", "first-after", "second-before"],
        focus: "second",
        after: ["second-after"],
      },
    });
  });

  it("keeps the landed editor identity when equal excerpts name different occurrences", () => {
    const rows = [2, 2.1].flatMap((start) =>
      utterance([
        { text: "before", start: 1, end: 1.2, word_index: 1 },
        { text: "gnu", start, end: 2.3, word_index: 2, unsure: true },
        { text: "after", start: 3, end: 3.2, word_index: 3 },
      ]),
    );
    const { entries, targets } = unsureEntriesOf([], rows);
    expect(entries.map((entry) => entry.item.id)).toEqual(["word:host::2"]);
    expect(entries[0]?.content.card.unsure).toEqual({
      word: "gnu",
      guess: "gnu",
      editorIdentity: JSON.stringify(["host", null, 2, 2.3, "gnu"]),
    });
    expect(targets.get("word:host::2")).not.toHaveProperty("context");
  });
});

describe("commentEntriesOf", () => {
  const at = (id: string, start: number, over = {}) =>
    sampleComment({ id, timeline_start: start, ...over });

  it("lists one comment item per comment with its row and card", () => {
    const [entry] = commentEntriesOf([
      at("c1", 65, {
        author: "Rosa",
        body: "Lose the cough\nbefore the story",
        replies: [
          { id: "r1", body: "On it", author: "Sam", created_at: "" },
          { id: "r2", body: "Thanks", author: "Rosa", created_at: "" },
        ],
      }),
    ]);
    expect(entry?.item).toEqual({
      id: "comment:c1",
      kind: "comment",
      at: 65,
      savedSeconds: 0,
    });
    expect(entry?.content.row).toEqual({
      snippet: "Lose the cough",
      time: "1:05",
      author: { name: "Rosa" },
      value: "2 replies",
    });
    expect(entry?.content.card.comment).toMatchObject({
      body: "Lose the cough\nbefore the story",
      replies: 2,
    });
  });

  it("puts a resolved comment in Decided and leaves an open one undecided", () => {
    const items = commentEntriesOf([
      at("a", 5),
      at("b", 9, { resolved: true }),
    ]).map((e) => e.item);
    expect(items.map((i) => i.result)).toEqual([undefined, "applied"]);
    expect(decidedItems(items).map((i) => i.id)).toEqual(["comment:b"]);
    expect(filterCounts(items).comments).toBe(1);
  });

  it("shows a pending resolve or reopen before the project does", () => {
    const entries = commentEntriesOf(
      [at("a", 5), at("b", 9, { resolved: true })],
      new Map([
        ["a", true],
        ["b", false],
      ]),
    );
    expect(entries.map((e) => e.item.result)).toEqual(["applied", undefined]);
  });

  it("round trips the item id", () => {
    expect(commentIdOf(commentItemId("c1"))).toBe("c1");
    expect(commentIdOf("edit:c1")).toBeNull();
  });

  it("gives a comment with no placed time an Unplaced row that sorts last", () => {
    const [entry] = commentEntriesOf([at("c", Number.NaN)]);
    expect(entry?.content.row.time).toBe("Unplaced");
    expect(entry?.item.at).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("sessionEntriesOf", () => {
  const tracks = [
    sampleTrack({ id: "host", label: "Jon" }),
    sampleTrack({ id: "guest", label: "Rosa" }),
  ];
  const replace = sessionSuggestionView({
    id: "ss-r",
    kind: "replace",
    session_number: 3,
    at_sec: null,
    from_sec: 724,
    to_sec: 1049,
    track_ids: ["host", "guest"],
    take_count: 3,
    take_indexes: [0, 1, 2],
    selected_take: null,
  });

  it("titles an insert with its session and time, and names the tracks and takes", () => {
    const [entry] = sessionEntriesOf(
      [sessionSuggestionView({ take_count: 2, take_indexes: [0, 1] })],
      tracks,
    );
    expect(entry?.content.card.title).toBe("Insert Session 2 at 12:04");
    expect(entry?.content.card.why).toBe("2 takes · Jon");
    expect(entry?.content.card.change).toEqual({ start: 724, end: 724 });
    expect(entry?.item).toMatchObject({
      id: "session:ss-1",
      kind: "pickup",
      at: 724,
      savedSeconds: 0,
      pickup: { kind: "insert", number: 2 },
    });
    expect(entry?.item.hostOnly).toBeUndefined();
  });

  it("titles a replace with its range; the switcher carries the take, the line names the tracks", () => {
    const [entry] = sessionEntriesOf([replace], tracks);
    expect(entry?.content.card.title).toBe(
      "Replace 12:04–17:29 with Session 3",
    );
    expect(entry?.content.card.why).toBe("Jon and Rosa");
    expect(entry?.content.row.value).toBe("Take 3 of 3");
    expect(entry?.content.takes).toEqual({
      selected: 2,
      takes: [{ takeIndex: 0 }, { takeIndex: 1 }, { takeIndex: 2 }],
    });
    expect(entry?.content.card.change).toEqual({ start: 724, end: 1049 });
    expect(entry?.item.pickup).toEqual({ kind: "replace", number: 3 });
  });

  it("shows the selected take, by its position among the distinct takes", () => {
    const [entry] = sessionEntriesOf(
      [{ ...replace, take_indexes: [0, 2, 5], selected_take: 2 }],
      tracks,
    );
    expect(entry?.content.row.value).toBe("Take 2 of 3");
    expect(entry?.content.takes?.selected).toBe(2);
  });

  it("adds each take's length, words, snippet and refusal once the takes route has answered", () => {
    const detail = (
      take_index: number,
      over: Partial<SessionTakes["takes"][number]> = {},
    ): SessionTakes["takes"][number] => ({
      take_index,
      duration_s: 8.44,
      word_count: 22,
      speech_text: "The reason we",
      chosen: false,
      default: false,
      acceptable: true,
      refusal: null,
      ...over,
    });
    const reply: SessionTakes = {
      suggestion_id: "ss-r",
      kind: "replace",
      selectable: true,
      selected_take: null,
      default_take: 2,
      takes: [
        detail(0),
        detail(1, { word_count: null, speech_text: null }),
        detail(2, {
          word_count: 1,
          acceptable: false,
          refusal: { code: "x", message: "Too short." },
        }),
      ],
    };
    const [entry] = sessionEntriesOf(
      [replace],
      tracks,
      new Map([["ss-r", reply]]),
    );
    expect(entry?.content.takes?.takes).toEqual([
      {
        takeIndex: 0,
        length: "8.4 s",
        words: "22 words",
        snippet: "The reason we",
      },
      { takeIndex: 1, length: "8.4 s" },
      {
        takeIndex: 2,
        length: "8.4 s",
        words: "1 word",
        snippet: "The reason we",
        refusal: "Too short.",
      },
    ]);
  });

  it("has no switcher for an insert or a single-take replace", () => {
    const [insert, single] = sessionEntriesOf(
      [
        sessionSuggestionView({ take_count: 2, take_indexes: [0, 1] }),
        { ...replace, take_count: 1, take_indexes: [0] },
      ],
      tracks,
    );
    expect(insert?.content.takes).toBeUndefined();
    expect(single?.content.takes).toBeUndefined();
  });

  it("says one take for a single take and falls back to the track id", () => {
    const [entry] = sessionEntriesOf(
      [{ ...replace, take_count: 1, take_indexes: [0], track_ids: ["x"] }],
      tracks,
    );
    expect(entry?.content.card.why).toBe("1 take · x");
  });

  it("places an unplaced session last, with no range to hear", () => {
    const [entry] = sessionEntriesOf(
      [{ ...replace, from_sec: null, to_sec: null }],
      tracks,
    );
    expect(entry?.item.at).toBe(Number.POSITIVE_INFINITY);
    expect(entry?.content.row.time).toBe("Unplaced");
    expect(entry?.content.card.change).toBeUndefined();
  });

  it("reads the id round trip, the start and the take to place", () => {
    expect(sessionIdOf(sessionItemId("ss-9"))).toBe("ss-9");
    expect(sessionIdOf("edit:ss-9")).toBeNull();
    expect(sessionStartSec(replace)).toBe(724);
    expect(sessionStartSec(sessionSuggestionView())).toBe(724);
    expect(takeToPlace(replace)).toBe(2);
    expect(takeToPlace({ ...replace, selected_take: 1 })).toBe(1);
    expect(takeToPlace(sessionSuggestionView())).toBeUndefined();
  });
});

describe("pickupConfirmation", () => {
  const tracks = [sampleTrack({ id: "guest", label: "Rosa" })];
  const ask = (rows: unknown) => ({
    needs_confirmation: { message: "x", speech: { tracks: rows } },
  });

  it("names the speakers whose speech goes", () => {
    expect(
      pickupConfirmation(
        ask([
          { track_id: "a", speaker: "Jon" },
          { track_id: "guest", speaker: "" },
          { track_id: "a", speaker: "Jon" },
        ]),
        tracks,
      ),
    ).toBe("This also removes speech from Jon and Rosa.");
  });

  it("is null for a reply that was not held and plain when no name is known", () => {
    expect(pickupConfirmation({ ok: true }, tracks)).toBeNull();
    expect(pickupConfirmation(ask([]), tracks)).toBe(
      "This also removes speech from another track.",
    );
  });
});

describe("suggestionTimesOf", () => {
  const edits = [
    pendingEditView({ id: "a", timeline_start: 5 }),
    pendingEditView({
      id: "b",
      timeline_start: 9,
      unsure_words: [{} as PendingUnsureWord],
    }),
    pendingEditView({ id: "c", timeline_start: null }),
    pendingEditView({ id: "d", timeline_start: 20, applied: true }),
  ];

  it("lists the starts of cuts waiting for review, and hides the unsure ones from a guest", () => {
    expect(suggestionTimesOf(edits, false)).toEqual([5, 9]);
    expect(suggestionTimesOf(edits, true)).toEqual([5]);
  });
});
