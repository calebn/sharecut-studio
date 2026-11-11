import { describe, expect, it } from "vitest";
import { QUEUE_ITEMS } from "../storybook/reviewFixtures";
import { offlineConflict } from "../test/fixtures";
import { TRANSCRIPT_REFINE_REFUSAL } from "../utils/apiError";
import {
  attentionLabelOf,
  attentionRowsOf,
  attentionVisible,
  commentLine,
  decidedItems,
  decisionMessage,
  filterCounts,
  filterItems,
  fullOrder,
  groupQueue,
  itemVerb,
  landPlan,
  lowRiskBulk,
  pendingLabelOf,
  progressLine,
  type ReviewAttention,
  type ReviewItem,
  resultText,
  speakersOf,
  sumSaved,
} from "./reviewQueueModel";

const item = (over: Partial<ReviewItem>): ReviewItem => ({
  id: "x",
  kind: "filler",
  at: 0,
  savedSeconds: 0.5,
  ...over,
});

describe("a guest's own suggestions", () => {
  it("collects them after the comments, whatever their kind, and no kind group keeps one", () => {
    const groups = groupQueue([
      item({ id: "c", kind: "comment", at: 5 }),
      item({ id: "m2", kind: "pause", at: 9, mine: true }),
      item({ id: "m1", kind: "suggestion", at: 2, mine: true }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Comments",
      "Your suggestions",
    ]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(groups[1]?.bulk).toBeNull();
  });

  it("leaves the group out when none is undecided", () => {
    expect(
      groupQueue([item({ id: "m", mine: true, result: "applied" })]),
    ).toEqual([]);
  });
});

describe("queue order", () => {
  it("groups every kind in the same fixed order", () => {
    const kinds = [
      "suggestion",
      "sound",
      "false-start",
      "repeat",
      "pause",
      "filler",
      "pickup",
      "comment",
      "unsure-word",
      "check",
    ] as const;
    expect(
      groupQueue(kinds.map((kind) => item({ id: kind, kind }))).map(
        (group) => group.kind,
      ),
    ).toEqual([
      "check",
      "unsure-word",
      "comment",
      "pickup",
      "filler",
      "pause",
      "repeat",
      "false-start",
      "sound",
      "suggestion",
    ]);
  });
});

describe("pickups", () => {
  const pickup = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    id: "session:a",
    kind: "pickup",
    at: 724,
    savedSeconds: 0,
    pickup: { kind: "replace", number: 2 },
    ...over,
  });

  it("groups them as Pickups, never bulk, and never counts them as seconds saved", () => {
    const [group] = groupQueue([pickup(), pickup({ id: "session:b" })]);
    expect(group).toMatchObject({
      kind: "pickup",
      label: "Pickups",
      bulk: null,
      held: 0,
    });
    expect(
      progressLine([pickup({ result: "applied" }), pickup({ id: "b" })]),
    ).toBe("1 of 2 decided · saves 0.0 s");
  });

  it("filters them with the suggestions and counts them there", () => {
    const items = [
      pickup(),
      item({ id: "f" }),
      item({ id: "m", kind: "comment" }),
    ];
    expect(filterItems(items, "suggestions").map((i) => i.id)).toEqual([
      "session:a",
      "f",
    ]);
    expect(filterCounts(items)).toMatchObject({
      all: 3,
      suggestions: 2,
      comments: 1,
    });
  });

  it("takes Replace or Insert as its verb and words the result with the session", () => {
    expect(itemVerb(pickup())).toBe("replace");
    expect(itemVerb(pickup({ pickup: { kind: "insert", number: 2 } }))).toBe(
      "insert",
    );
    expect(resultText(pickup({ result: "applied" }))).toBe("Added Session 2");
    expect(resultText(pickup({ result: "kept" }))).toBe("Skipped Session 2");
    expect(decisionMessage([pickup()], ["session:a"], "applied")).toBe(
      "Added Session 2",
    );
  });
});

describe("bulk eligibility", () => {
  const bulkIds = (items: ReviewItem[]) =>
    groupQueue(items)[0]?.bulk?.ids ?? [];

  it("leaves out unsure, blocked and leave-alone items", () => {
    const ids = bulkIds([
      item({ id: "a" }),
      item({ id: "b", unsure: true }),
      item({ id: "c", suggested: "leave" }),
      item({ id: "d", suggested: "cut" }),
      item({ id: "e", blocked: true }),
    ]);
    expect(ids).toEqual(["a", "d"]);
  });

  it("counts unsure and blocked items as held, not keep or lower", () => {
    const group = groupQueue([
      item({ id: "a" }),
      item({ id: "b", blocked: true }),
      item({ id: "c", unsure: true }),
      item({ id: "d", suggested: "leave" }),
      item({ id: "e", suggested: "lower" }),
    ])[0];
    expect(group?.held).toBe(2);
    expect(group?.bulk?.ids).toEqual(["a"]);
  });

  it("counts a blocked row, which still takes Keep, but not a host-only one", () => {
    const group = groupQueue([
      item({ id: "a" }),
      item({ id: "b", blocked: true }),
      item({ id: "c", blocked: true, hostOnly: true }),
    ])[0];
    expect(group?.held).toBe(1);
  });

  it("gives other suggestions a group but no group verb", () => {
    const group = groupQueue([item({ id: "g", kind: "suggestion" })])[0];
    expect(group?.label).toBe("Other suggestions");
    expect(group?.bulk).toBeNull();
  });
});

describe("groupQueue", () => {
  it("orders groups by kind and items by time, undecided only", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    expect(groups.map((g) => g.kind)).toEqual([
      "check",
      "unsure-word",
      "comment",
      "filler",
      "pause",
      "sound",
    ]);
    expect(groups[3]?.items.map((i) => i.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("counts only what the bulk will cut, as one number", () => {
    const fillers = groupQueue(QUEUE_ITEMS).find((g) => g.kind === "filler");
    expect(fillers?.bulk?.verb).toBe("cut");
    expect(fillers?.bulk?.ids).toEqual(["f1", "f2", "f4"]);
    expect(fillers?.bulk?.savedSeconds).toBeCloseTo(0.8 + 0.6 + 0.7);
  });

  it("leaves unsure, blocked and decided items out of the bulk", () => {
    const rows = [
      item({ id: "a" }),
      item({ id: "b", unsure: true }),
      item({ id: "c", blocked: true }),
      item({ id: "d", result: "kept" }),
    ];
    expect(groupQueue(rows)[0]?.bulk?.ids).toEqual(["a"]);
    expect(groupQueue([item({ id: "b", blocked: true })])[0]?.bulk).toBeNull();
  });

  it("never offers a bulk on checks, words or comments", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    for (const kind of ["check", "unsure-word", "comment"]) {
      expect(groups.find((g) => g.kind === kind)?.bulk).toBeNull();
    }
  });
});

describe("counts and progress", () => {
  it("counts undecided items per filter", () => {
    expect(filterCounts(QUEUE_ITEMS)).toEqual({
      all: 10,
      suggestions: 7,
      comments: 1,
      checks: 2,
    });
    expect(filterItems(QUEUE_ITEMS, "comments").map((i) => i.id)).toEqual([
      "m1",
    ]);
  });

  it("lists decided items", () => {
    expect(decidedItems(QUEUE_ITEMS).map((i) => i.id)).toEqual(["f0", "p0"]);
  });

  it("writes one progress sentence", () => {
    expect(progressLine(QUEUE_ITEMS)).toBe("2 of 12 decided · saves 0.5 s");
  });

  it("writes a comment sentence without savings", () => {
    expect(commentLine(QUEUE_ITEMS)).toBe("2 of 12 resolved");
  });
});

describe("resultText", () => {
  it("names what was done", () => {
    expect(resultText(item({ result: "applied", savedSeconds: 0.8 }))).toBe(
      "Cut 0.8 s",
    );
    expect(resultText(item({ result: "kept" }))).toBe("Kept");
  });
});

describe("decisionMessage", () => {
  it("names one decision and sums a bulk", () => {
    expect(decisionMessage(QUEUE_ITEMS, ["f1"], "applied")).toBe("Cut 0.8 s");
    expect(decisionMessage(QUEUE_ITEMS, ["f1", "f2"], "applied")).toBe(
      "Cut 2 · saves 1.4 s",
    );
    expect(decisionMessage(QUEUE_ITEMS, ["f1", "f2"], "kept")).toBe("Kept 2");
  });
});

describe("itemVerb", () => {
  it.each([
    [{ kind: "filler" }, "cut"],
    [{ kind: "pause" }, "shorten"],
    [{ kind: "sound" }, "lower"],
    [{ kind: "check" }, "approve"],
    [{ kind: "suggestion", suggested: "shorten" }, "shorten"],
    [{ kind: "sound", suggested: "cut" }, "cut"],
    [{ kind: "sound", suggested: "lower" }, "lower"],
    [{ kind: "filler", suggested: "lower" }, "lower"],
    [{ kind: "sound", suggested: "leave" }, "keep"],
    [{ kind: "filler", suggested: undefined }, "cut"],
  ] as const)("gives %o the %s verb", (over, verb) => {
    expect(itemVerb(item({ ...over }))).toBe(verb);
  });

  it("words the result and the bulk message from it", () => {
    const shorten = item({ id: "s", kind: "suggestion", suggested: "shorten" });
    expect(resultText({ ...shorten, result: "applied" })).toBe("Shorten 0.5 s");
    expect(decisionMessage([shorten], ["s"], "applied")).toBe("Shorten 0.5 s");
  });

  it.each([
    [["cut", "lower", undefined], "cut", ["a"]],
    [["shorten", "shorten"], "shorten", ["a", "b"]],
    [["cut", "shorten"], "approve", ["a", "b"]],
  ] as const)(
    "words a sound group of %j as %s over %j, never lowering",
    (suggested, verb, ids) => {
      const rows = suggested.map((s, i) =>
        item({ id: "abc"[i] as string, kind: "sound", suggested: s }),
      );
      const bulk = groupQueue(rows)[0]?.bulk;
      expect(bulk?.verb).toBe(verb);
      expect(bulk?.ids).toEqual(ids);
      expect(decisionMessage(rows, [...ids], "applied")).toMatch(
        new RegExp(`^${verb}`, "i"),
      );
    },
  );
});

describe("landing a comment pick", () => {
  const items = [
    item({ id: "comment:open", kind: "comment" }),
    item({ id: "comment:done", kind: "comment", result: "applied" }),
    item({ id: "filler:1", kind: "filler" }),
  ];

  it("selects an open comment and keeps a filter that shows comments", () => {
    expect(landPlan(items, "comment:open", "comments")).toEqual({
      select: true,
      resetFilter: false,
    });
    expect(landPlan(items, "comment:open", "all")).toEqual({
      select: true,
      resetFilter: false,
    });
  });

  it("resets a filter that hides comments to All", () => {
    for (const filter of ["suggestions", "checks"] as const)
      expect(landPlan(items, "comment:open", filter)).toEqual({
        select: true,
        resetFilter: true,
      });
  });

  it("leaves a decided comment alone, even under a hiding filter", () => {
    expect(landPlan(items, "comment:done", "suggestions")).toEqual({
      select: false,
      resetFilter: false,
    });
  });

  it("still selects an id that is not in the queue", () => {
    expect(landPlan(items, "comment:new", "all")).toEqual({
      select: true,
      resetFilter: false,
    });
    expect(landPlan(items, "comment:new", "suggestions")).toEqual({
      select: true,
      resetFilter: true,
    });
  });
});

describe("confidence tiers", () => {
  const risky = (id: string, rank: 1 | 2 | 3, at = 0) =>
    item({ id, at, risk: { rank, reason: "r" } });

  it("lists each group riskiest first, then by time", () => {
    const [group] = groupQueue([
      item({ id: "clean", at: 1 }),
      risky("mild", 1, 2),
      risky("harsh", 3, 9),
      risky("join", 2, 5),
    ]);
    expect(group?.items.map((i) => i.id)).toEqual([
      "harsh",
      "join",
      "mild",
      "clean",
    ]);
  });

  it("steps through the queue in the order it is drawn, riskiest first", () => {
    const items = [
      item({ id: "clean", at: 1 }),
      risky("harsh", 3, 9),
      item({ id: "pause", kind: "pause", at: 0 }),
    ];
    expect(fullOrder(items).map((i) => i.id)).toEqual(
      groupQueue(items)
        .flatMap((g) => g.items)
        .map((i) => i.id),
    );
  });

  it("batches the clean cuts of every kind in time order", () => {
    const batch = lowRiskBulk([
      item({ id: "p", kind: "pause", at: 9 }),
      item({ id: "f", kind: "filler", at: 3 }),
      risky("r", 2),
      item({ id: "u", unsure: true }),
    ]);
    expect(batch?.ids).toEqual(["f", "p"]);
    expect(batch?.savedSeconds).toBeCloseTo(1);
  });

  it("offers no batch when nothing is clean or everything is", () => {
    expect(lowRiskBulk([risky("r", 1)])).toBeNull();
    expect(lowRiskBulk([item({ id: "a" }), item({ id: "b" })])).toBeNull();
  });
});

describe("speaker filter", () => {
  const host = { id: "host", label: "Host" };
  const guest = { id: "guest", label: "Guest" };
  const items = [
    item({ id: "a", speaker: host }),
    item({ id: "b", speaker: guest }),
    item({ id: "c", speaker: guest, result: "applied" }),
    item({ id: "n", kind: "comment", savedSeconds: 0 }),
  ];

  it("shows one person's edits and leaves comments and checks in view", () => {
    expect(filterItems(items, "all", "guest").map((i) => i.id)).toEqual([
      "b",
      "c",
      "n",
    ]);
    expect(filterItems(items, "all").length).toBe(4);
  });

  it("counts only the open items of that person", () => {
    expect(filterCounts(items, "guest").all).toBe(2);
    expect(filterCounts(items).all).toBe(3);
  });

  it("lists people in order of first appearance with their open counts, and none for one person", () => {
    expect(speakersOf(items)).toEqual([
      { ...host, open: 1 },
      { ...guest, open: 1 },
    ]);
    expect(speakersOf([items[0]!, items[3]!])).toEqual([]);
  });
});

describe("attention rows", () => {
  const attention = (over: Partial<ReviewAttention> = {}): ReviewAttention => ({
    pending: 0,
    rows: attentionRowsOf([offlineConflict()], true),
    unreadable: false,
    dismissFailed: false,
    checking: false,
    canDismiss: true,
    onDismissAll: () => undefined,
    onRetry: () => undefined,
    ...over,
  });

  it("carries the cut suggestion of a stale refusal and leaves the generic words", () => {
    const [row] = attentionRowsOf(
      [
        offlineConflict({
          code: "range_changed",
          reason: "Selected audio changed. Select the range again.",
          command: {
            command_id: "cut-1",
            type: "EditSelectedRange",
            payload: {
              action: "cut",
              targets: [
                { intervals: [{ start: 724, end: 727 }], track_ids: ["t"] },
              ],
            },
          },
        }),
      ],
      true,
    );
    expect(row?.title).toBe(
      "Your change: Selected audio changed. Select the range again.",
    );
    expect(row?.detail).toBe("Edit the change and submit it again.");
    expect(row?.suggestion).toMatchObject({
      title: "Your cut at 12:04 overlaps a newer edit",
      startSec: 724,
      endSec: 727,
      trackIds: ["t"],
    });
  });

  it("words each conflict for the queue, with the guest advice", () => {
    expect(
      attentionRowsOf(
        [
          offlineConflict({ command: { command_id: "a", type: "TrimClip" } }),
          offlineConflict({
            command: { command_id: "b" },
            kind: "unknown",
            reason: "Unclear",
            recovery: "inspect-history",
          }),
          offlineConflict({
            command: { command_id: "c" },
            reason: "Missing",
            blocksSave: true,
          }),
          offlineConflict({
            command: { command_id: "d" },
            kind: "unknown",
            reason: "Dropped",
            recovery: "retry-same-command",
          }),
        ],
        true,
      ),
    ).toEqual([
      {
        id: "a",
        title: "Your change: Envelope changed since this edit was queued",
        detail: "Edit the change and submit it again.",
      },
      {
        id: "b",
        title: "Your change: Unclear",
        detail:
          "Ask the project owner to inspect History before trying this action again.",
      },
      {
        id: "c",
        title: "Your change: Missing",
        detail: "Ask the project owner to check the project.",
      },
      {
        id: "d",
        title: "Your change: Dropped",
        detail: "The app will retry this same command automatically.",
      },
    ]);
  });

  it("words a host conflict with the host advice, the History action and the refine waiver", () => {
    expect(
      attentionRowsOf(
        [
          offlineConflict({
            command: { command_id: "a", type: "UndoHistory" },
            kind: "unknown",
            reason: "Unclear",
            recovery: "inspect-history",
          }),
          offlineConflict({
            command: { command_id: "b", type: "ApproveEdits" },
            reason: TRANSCRIPT_REFINE_REFUSAL,
          }),
          offlineConflict({
            command: { command_id: "c", type: "TrimClip" },
            reason: TRANSCRIPT_REFINE_REFUSAL,
          }),
          offlineConflict({ command: { command_id: "d" }, blocksSave: true }),
        ],
        false,
      ),
    ).toEqual([
      {
        id: "a",
        title: "Your change: Unclear",
        detail: "Inspect History before trying this action again.",
        inspectHistory: true,
      },
      {
        id: "b",
        title: `Your approval: ${TRANSCRIPT_REFINE_REFUSAL}`,
        detail: "",
        refineReason: TRANSCRIPT_REFINE_REFUSAL,
      },
      {
        id: "c",
        title: `Your change: ${TRANSCRIPT_REFINE_REFUSAL}`,
        detail: "",
        refineReason: TRANSCRIPT_REFINE_REFUSAL,
      },
      {
        id: "d",
        title: "Your change: Envelope changed since this edit was queued",
        detail: "Fix the project file first; this change was not saved.",
      },
    ]);
  });

  it("counts waiting edits in the label and shows for them alone", () => {
    expect(pendingLabelOf(1)).toBe("1 edit waiting to send");
    expect(pendingLabelOf(3)).toBe("3 edits waiting to send");
    const waiting = attention({ pending: 2, rows: [] });
    expect(attentionVisible(waiting, "all")).toBe(true);
    expect(attentionLabelOf(waiting)).toBe("Needs attention. 2 pending");
  });

  it("shows only under All and Checks, and only with something to say", () => {
    expect(attentionVisible(attention(), "all")).toBe(true);
    expect(attentionVisible(attention(), "checks")).toBe(true);
    expect(attentionVisible(attention(), "comments")).toBe(false);
    expect(attentionVisible(attention({ rows: [] }), "all")).toBe(false);
    expect(
      attentionVisible(attention({ rows: [], unreadable: true }), "all"),
    ).toBe(true);
    expect(
      attentionVisible(attention({ rows: [], dismissFailed: true }), "all"),
    ).toBe(true);
    expect(attentionVisible(attention({ rows: [], pending: 1 }), "all")).toBe(
      true,
    );
    expect(attentionVisible(undefined, "all")).toBe(false);
  });

  it("labels the group with its region label", () => {
    expect(attentionLabelOf(attention())).toBe("Needs attention. 1 conflict");
    expect(attentionLabelOf(attention({ unreadable: true }))).toBe(
      "Needs attention. 1 conflict. Saved edits could not be read",
    );
  });
});

describe("what a set of edits saves", () => {
  it("counts a moment once when two tracks cut it", () => {
    const span = [[10, 12.9]] as const;
    expect(
      sumSaved([
        item({ id: "a", savedSeconds: 2.9, spans: span }),
        item({ id: "b", savedSeconds: 2.9, spans: span }),
      ]),
    ).toBeCloseTo(2.9);
  });

  it("counts only the union of ranges that overlap", () => {
    expect(
      sumSaved([
        item({ id: "a", savedSeconds: 2, spans: [[10, 12]] }),
        item({ id: "b", savedSeconds: 2, spans: [[11, 13]] }),
        item({ id: "c", savedSeconds: 1, spans: [[20, 21]] }),
      ]),
    ).toBeCloseTo(4);
  });

  it("falls back to an item's own seconds when it has no ranges", () => {
    expect(
      sumSaved([
        item({ id: "a", savedSeconds: 1.5 }),
        item({ id: "b", savedSeconds: 2, spans: [[3, 5]] }),
      ]),
    ).toBeCloseTo(3.5);
  });

  it("falls back to an item's seconds when its only ranges are empty, and skips a NaN figure", () => {
    expect(
      sumSaved([
        item({ id: "a", savedSeconds: 2, spans: [[5, 5]] }),
        item({ id: "b", savedSeconds: Number.NaN }),
      ]),
    ).toBe(2);
  });

  it("ignores empty and non-finite ranges", () => {
    expect(
      sumSaved([
        item({
          savedSeconds: 0,
          spans: [
            [5, 5],
            [Number.NaN, 7],
          ],
        }),
      ]),
    ).toBe(0);
  });
});
