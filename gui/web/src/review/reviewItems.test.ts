import { describe, expect, it } from "vitest";
import { pendingEditView, sampleComment } from "../test/fixtures";
import type { PendingKind, TranscriptCheckStatus } from "../types/project";
import {
  CHECK_ID,
  checkEntryOf,
  commentEntriesOf,
  commentIdOf,
  commentItemId,
  editIdOf,
  reviewEntriesOf,
  reviewIdOf,
  unsureEntriesOf,
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

describe("reviewEntriesOf", () => {
  it("lists only edits that are not applied and need review", () => {
    const entries = reviewEntriesOf([
      pendingEditView({ id: "a" }),
      pendingEditView({ id: "b", applied: true }),
      pendingEditView({ id: "c", review_required: false }),
    ]);
    expect(entries.map((e) => e.item.id)).toEqual(["edit:a"]);
  });

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

  it("follows the server flag listen_one_by_one === true, holds non-pass join risk, not harsh ones", () => {
    const real = {
      review_required: true,
      harsh: true,
      listen_one_by_one: false,
      join_risk: null,
    };
    expect(itemOf(real).oneByOne).toBe(false);
    expect(itemOf({ ...real, listen_one_by_one: true }).oneByOne).toBe(true);
    const join_risk = { verdict: "review" } as never;
    expect(itemOf({ ...real, join_risk }).oneByOne).toBe(true);
    const pass = { verdict: "pass" } as never;
    expect(itemOf({ ...real, join_risk: pass }).oneByOne).toBe(false);
    expect(itemOf({ harsh: false }).oneByOne).toBe(false);
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
      suggested: undefined,
      oneByOne: false,
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
    expect(checkEntryOf(status(over))).toBeNull();
  });

  it("is the transcript check, first in its group, with no edit id", () => {
    const entry = checkEntryOf(status({}));
    expect(entry?.item).toEqual({
      id: CHECK_ID,
      kind: "check",
      at: Number.NEGATIVE_INFINITY,
      savedSeconds: 0,
      transcript: true,
    });
    expect(editIdOf(CHECK_ID)).toBeNull();
    expect(entry?.content.check?.detail).toBe(
      "3 words the transcript is unsure of.",
    );
  });

  it("words the detail as the count even when the server sends a hint", () => {
    expect(
      checkEntryOf(status({ hint: "Run the CLI." }))?.content.check?.detail,
    ).toBe("3 words the transcript is unsure of.");
  });
});

describe("unsureEntriesOf", () => {
  const word = (index: number, text: string) => ({
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

  it("places a cut-only word at its own start, not the cut's, when the transcript has it", () => {
    const { entries } = unsureEntriesOf(
      [cut("a", 20)],
      utterance([
        { text: "gnu", start: 5, end: 6, timeline_start: 5, word_index: 1 },
      ]),
    );
    expect(entries.map((e) => e.item.at)).toEqual([5]);
  });

  it("falls back to the cut's start when the transcript lacks the word", () => {
    const { entries } = unsureEntriesOf([cut("a", 20)], utterance([]));
    expect(entries.map((e) => e.item.at)).toEqual([20]);
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
