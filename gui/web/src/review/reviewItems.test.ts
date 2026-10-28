import { describe, expect, it } from "vitest";
import { pendingEditView } from "../test/fixtures";
import type { PendingKind, TranscriptCheckStatus } from "../types/project";
import {
  CHECK_ID,
  checkEntryOf,
  decisionKindOf,
  editIdOf,
  reviewEntriesOf,
  reviewIdOf,
} from "./reviewItems";
import { fullOrder, type ReviewItem } from "./reviewQueueModel";

const itemOf = (over: Parameters<typeof pendingEditView>[0] = {}) => {
  const [entry] = reviewEntriesOf([pendingEditView(over)]);
  if (!entry) throw new Error("not listed");
  return entry.item;
};

describe("decisionKindOf", () => {
  it.each([
    ["filler", "filler"],
    ["pause", "pause"],
    ["repeat", "repeat"],
    ["false-start", "false-start"],
    ["sound", "sound"],
    ["other", "suggestion"],
  ] satisfies [PendingKind, string][])("maps %s to %s", (wire, kind) => {
    expect(decisionKindOf(wire)).toBe(kind);
  });

  it.each([undefined, null, "mystery", "constructor", "__proto__", 7])(
    "gives suggestion for %s",
    (wire) => {
      expect(decisionKindOf(wire)).toBe("suggestion");
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

  it("prefers the server hint", () => {
    expect(
      checkEntryOf(status({ hint: "Check the names." }))?.content.check?.detail,
    ).toBe("Check the names.");
  });
});
