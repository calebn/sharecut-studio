import { describe, expect, it } from "vitest";
import { pendingEditView } from "../test/fixtures";
import type { PendingKind } from "../types/project";
import {
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

  it.each(["lower", "leave"] as const)(
    "saves nothing when the table action is %s",
    (action) => {
      expect(itemOf({ suggested_action: action }).savedSeconds).toBe(0);
    },
  );

  it.each(["cut", "shorten"] as const)("counts spans for %s", (action) => {
    expect(itemOf({ suggested_action: action }).savedSeconds).toBe(1);
  });

  it("puts an unplaced edit at Infinity, last in the queue", () => {
    const placed = itemOf({ id: "p", timeline_start: 5 });
    const unplaced = itemOf({ id: "u", timeline_start: null });
    expect(unplaced.at).toBe(Number.POSITIVE_INFINITY);
    const order = fullOrder([unplaced, placed] satisfies ReviewItem[]);
    expect(order.map((i) => i.id)).toEqual(["edit:p", "edit:u"]);
  });

  it("keeps harsh and listen_one_by_one edits out of group verbs", () => {
    expect(itemOf({ harsh: true }).oneByOne).toBe(true);
    expect(itemOf({ listen_one_by_one: true }).oneByOne).toBe(true);
    expect(itemOf({}).oneByOne).toBe(false);
  });

  it("passes the table action through", () => {
    expect(itemOf({ suggested_action: "leave" }).suggested).toBe("leave");
    expect(itemOf({ suggested_action: null }).suggested).toBeUndefined();
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
    expect(entry?.content.card).toEqual({ title: "Long pause", time: "0:02" });
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
