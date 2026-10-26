import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVANCE_BUDGET_MS,
  decideAndAdvance,
  later,
  nextUndecided,
  previousUndecided,
  undoDecision,
} from "./advance";
import { QUEUE_ITEMS } from "./reviewFixtures";
import { groupQueue, type ReviewItem } from "./reviewQueue";

afterEach(() => vi.useRealTimers());

describe("decideAndAdvance", () => {
  it("selects the next undecided item and collapses the decided one", () => {
    const outcome = decideAndAdvance(QUEUE_ITEMS, "f1", "applied");
    expect(outcome.selectedId).toBe("f2");
    expect(outcome.items.find((i) => i.id === "f1")?.result).toBe("applied");
    const open = groupQueue(outcome.items).flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(open).not.toContain("f1");
  });

  it("moves across groups and wraps to the start", () => {
    const last = decideAndAdvance(QUEUE_ITEMS, "p2", "kept");
    expect(last.selectedId).toBe("s1");
    expect(decideAndAdvance(last.items, "s1", "kept").selectedId).toBe("c1");
  });

  it("ends with null when nothing is left", () => {
    const only: ReviewItem[] = [
      { id: "a", kind: "filler", at: 1, savedSeconds: 1 },
    ];
    expect(decideAndAdvance(only, "a", "applied").selectedId).toBeNull();
  });

  it("does not touch the input", () => {
    const before = JSON.stringify(QUEUE_ITEMS);
    decideAndAdvance(QUEUE_ITEMS, "f1", "applied");
    expect(JSON.stringify(QUEUE_ITEMS)).toBe(before);
  });

  it("answers synchronously, with no timer or promise, inside the budget", () => {
    vi.useFakeTimers();
    const many: ReviewItem[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `i${i}`,
      kind: i % 2 ? "pause" : "filler",
      at: i,
      savedSeconds: 0.5,
    }));
    const started = performance.now();
    const outcome = decideAndAdvance(many, "i0", "applied");
    expect(performance.now() - started).toBeLessThan(ADVANCE_BUDGET_MS);
    expect(outcome.selectedId).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("later, previous and undo", () => {
  it("later moves on without deciding", () => {
    const outcome = later(QUEUE_ITEMS, "f1");
    expect(outcome.selectedId).toBe("f2");
    expect(outcome.items.find((i) => i.id === "f1")?.result).toBeUndefined();
  });

  it("steps back and wraps to the end", () => {
    expect(previousUndecided(QUEUE_ITEMS, "f2")).toBe("f1");
    expect(previousUndecided(QUEUE_ITEMS, "c1")).toBe("s1");
  });

  it("has no other item to step to when one is left", () => {
    const one: ReviewItem[] = [
      { id: "a", kind: "filler", at: 1, savedSeconds: 1 },
    ];
    expect(previousUndecided(one, "a")).toBeNull();
    expect(nextUndecided(one, "a")).toBeNull();
  });

  it("undo puts the item back and selects it", () => {
    const decided = decideAndAdvance(QUEUE_ITEMS, "f1", "applied").items;
    const back = undoDecision(decided, "f1");
    expect(back.selectedId).toBe("f1");
    expect(back.items.find((i) => i.id === "f1")?.result).toBeUndefined();
  });
});
