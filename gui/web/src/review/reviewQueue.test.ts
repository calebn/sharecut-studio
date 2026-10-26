import { describe, expect, it } from "vitest";
import { QUEUE_ITEMS } from "./reviewFixtures";
import {
  bulkEligible,
  bulkLabel,
  decidedItems,
  formatSeconds,
  groupQueue,
  progressLine,
  progressOf,
  queueOrder,
  type ReviewItem,
  secondsSaved,
} from "./reviewQueue";

const make = (extra: Partial<ReviewItem>): ReviewItem => ({
  id: "x",
  kind: "filler",
  at: 0,
  savedSeconds: 1,
  ...extra,
});

describe("groupQueue", () => {
  const groups = groupQueue(QUEUE_ITEMS);

  it("orders groups by kind: Checks, Comments, then suggestions", () => {
    expect(groups.map((group) => group.kind)).toEqual([
      "check",
      "unsure-word",
      "comment",
      "filler",
      "pause",
      "sound",
    ]);
  });

  it("orders items inside a group by time and leaves decided items out", () => {
    const fillers = groups.find((group) => group.kind === "filler");
    expect(fillers?.items.map((item) => item.id)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
    ]);
    expect(groups.flatMap((g) => g.items).some((i) => i.result)).toBe(false);
  });

  it("totals the seconds a group would save", () => {
    const pauses = groups.find((group) => group.kind === "pause");
    expect(pauses?.savedSeconds).toBeCloseTo(4.2);
    expect(pauses?.undecided).toBe(2);
  });

  it("drops groups with nothing undecided", () => {
    expect(groupQueue([make({ id: "a", result: "applied" })]).length).toBe(0);
  });
});

describe("bulk eligibility", () => {
  it("never includes an unsure word or a cut that touches one", () => {
    const filler = groupQueue(QUEUE_ITEMS).find((g) => g.kind === "filler");
    expect(filler?.bulk?.ids).toEqual(["f1", "f2", "f4"]);
    expect(filler?.bulk?.count).toBe(3);
    expect(filler?.bulk?.verb).toBe("cut");
    expect(filler?.bulk?.savedSeconds).toBeCloseTo(2.1);
    expect(bulkEligible(make({ kind: "unsure-word" }))).toBe(false);
    expect(bulkEligible(make({ unsure: true }))).toBe(false);
  });

  it("has no bulk verb for checks, comments and unsure words", () => {
    const groups = groupQueue(QUEUE_ITEMS);
    for (const kind of ["check", "unsure-word", "comment"] as const) {
      expect(groups.find((g) => g.kind === kind)?.bulk).toBeNull();
    }
  });

  it("skips blocked and decided items", () => {
    expect(bulkEligible(make({ blocked: true }))).toBe(false);
    expect(bulkEligible(make({ result: "kept" }))).toBe(false);
    expect(bulkEligible(make({}))).toBe(true);
  });

  it("is absent when every item in a group is an unsure word", () => {
    const only = groupQueue([make({ id: "u", kind: "filler", unsure: true })]);
    expect(only[0]?.bulk).toBeNull();
  });

  it("labels the bulk verb with its count", () => {
    const filler = groupQueue(QUEUE_ITEMS).find((g) => g.kind === "filler");
    expect(filler && bulkLabel(filler, "Cut")).toBe("Cut all 3");
  });
});

describe("progress", () => {
  it("counts decided items and only the seconds applied cuts save", () => {
    const progress = progressOf(QUEUE_ITEMS);
    expect(progress.decided).toBe(2);
    expect(progress.total).toBe(QUEUE_ITEMS.length);
    expect(secondsSaved(QUEUE_ITEMS)).toBeCloseTo(0.5);
    expect(decidedItems(QUEUE_ITEMS).map((i) => i.id)).toEqual(["f0", "p0"]);
  });

  it("reads as one line", () => {
    expect(progressLine({ decided: 6, total: 14, savedSeconds: 7.84 })).toBe(
      "6 of 14 decided · saves 7.8 s",
    );
    expect(formatSeconds(0)).toBe("0.0 s");
  });
});

describe("queueOrder", () => {
  it("walks the groups in order", () => {
    expect(queueOrder(QUEUE_ITEMS).slice(0, 4)).toEqual([
      "c1",
      "u1",
      "m1",
      "f1",
    ]);
  });
});
