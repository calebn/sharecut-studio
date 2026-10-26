import { describe, expect, it } from "vitest";
import { QUEUE_ITEMS } from "../storybook/reviewFixtures";
import { planDecision, stepUndecided, undoDecisions } from "./advance";
import type { ReviewItem } from "./reviewQueue";

const make = (id: string, at: number, result?: "applied"): ReviewItem => ({
  id,
  kind: "filler",
  at,
  savedSeconds: 0.5,
  result,
});
const items = [make("a", 1), make("b", 2), make("c", 3), make("d", 4)];
const decided = (rows: readonly ReviewItem[], ...ids: string[]) =>
  rows.map((i) =>
    ids.includes(i.id) ? { ...i, result: "applied" as const } : i,
  );

describe("stepUndecided", () => {
  it("steps both ways and wraps", () => {
    expect(stepUndecided(items, "a", "forward")).toBe("b");
    expect(stepUndecided(items, "d", "forward")).toBe("a");
    expect(stepUndecided(items, "a", "backward")).toBe("d");
    expect(stepUndecided(items, null, "forward")).toBe("a");
    expect(stepUndecided(items, null, "backward")).toBe("d");
  });

  it("keeps a lone undecided item selected", () => {
    const rows = decided(items, "a", "b", "c");
    expect(stepUndecided(rows, "d", "forward")).toBe("d");
    expect(stepUndecided(rows, "d", "backward")).toBe("d");
  });

  it("goes after a decided current item, not to the top", () => {
    expect(stepUndecided(decided(items, "b"), "b", "forward")).toBe("c");
  });

  it("returns null when everything is decided", () => {
    expect(
      stepUndecided(decided(items, "a", "b", "c", "d"), "a", "forward"),
    ).toBeNull();
  });

  it("stays inside the active filter", () => {
    expect(stepUndecided(QUEUE_ITEMS, "m1", "forward", "comments")).toBe("m1");
    expect(stepUndecided(QUEUE_ITEMS, "m1", "backward", "comments")).toBe("m1");
  });
});

describe("planDecision", () => {
  it("decides and advances past the last id, then undoes", () => {
    const plan = planDecision(items, ["a", "b"], "applied");
    expect(plan.selectedId).toBe("c");
    expect(plan.decidedIds).toEqual(["a", "b"]);
    expect(plan.message).toBe("Cut 2 · saves 1.0 s");
    const back = undoDecisions(plan.items, plan.decidedIds);
    expect(back.selectedId).toBe("a");
    expect(back.items.every((i) => i.result === undefined)).toBe(true);
  });

  it("selects nothing once the visible queue is done", () => {
    expect(
      planDecision(items, ["a", "b", "c", "d"], "kept").selectedId,
    ).toBeNull();
  });

  it("resolves only the transcript check with the last unsure word", () => {
    const rows: ReviewItem[] = [
      { id: "c1", kind: "check", at: 0, savedSeconds: 0, transcript: true },
      { id: "c2", kind: "check", at: 1, savedSeconds: 0 },
      { id: "u1", kind: "unsure-word", at: 2, savedSeconds: 0 },
      { id: "u2", kind: "unsure-word", at: 3, savedSeconds: 0 },
    ];
    const first = planDecision(rows, ["u1"], "applied");
    expect(first.decidedIds).toEqual(["u1"]);
    const last = planDecision(first.items, ["u2"], "applied");
    expect(last.decidedIds).toEqual(["u2", "c1"]);
    expect(last.items.find((i) => i.id === "c2")?.result).toBeUndefined();
  });

  it("resolves only the transcript check with Cut anyway", () => {
    const rows: ReviewItem[] = [
      { id: "c1", kind: "check", at: 0, savedSeconds: 0, transcript: true },
      { id: "c2", kind: "check", at: 1, savedSeconds: 0 },
      make("a", 5),
    ];
    const plan = planDecision(rows, ["a"], "applied", { waive: true });
    expect(plan.decidedIds).toEqual(["a", "c1"]);
    expect(plan.items.find((i) => i.id === "c2")?.result).toBeUndefined();
  });

  it("advances within the filter", () => {
    const plan = planDecision(QUEUE_ITEMS, ["m1"], "applied", {
      filter: "comments",
    });
    expect(plan.selectedId).toBeNull();
  });

  it("runs synchronously inside the 100 ms budget", () => {
    const start = performance.now();
    planDecision(QUEUE_ITEMS, ["f1"], "applied");
    expect(performance.now() - start).toBeLessThan(100);
  });
});
