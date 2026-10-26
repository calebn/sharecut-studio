import { describe, expect, it } from "vitest";
import {
  ADVANCE_BUDGET_MS,
  decideAndAdvance,
  nextUndecided,
  previousUndecided,
  undoDecisions,
} from "./advance";
import type { ReviewItem } from "./reviewQueue";

const make = (id: string, at: number, result?: "applied"): ReviewItem => ({
  id,
  kind: "filler",
  at,
  savedSeconds: 0.5,
  result,
});
const items = [make("a", 1), make("b", 2), make("c", 3), make("d", 4)];

describe("advance", () => {
  it("selects the next undecided item and wraps", () => {
    expect(nextUndecided(items, "a")).toBe("b");
    expect(nextUndecided(items, "d")).toBe("a");
    expect(previousUndecided(items, "a")).toBe("d");
    expect(previousUndecided(items, null)).toBe("d");
  });

  it("goes after a decided current item, not to the top", () => {
    const decided = [make("a", 1), make("b", 2, "applied"), ...items.slice(2)];
    expect(nextUndecided(decided, "b")).toBe("c");
  });

  it("returns null when everything is decided", () => {
    const done = items.map((i) => ({ ...i, result: "applied" as const }));
    expect(nextUndecided(done, "a")).toBeNull();
    expect(decideAndAdvance(items, ["a", "b", "c", "d"], "applied")).toEqual({
      items: done,
      selectedId: null,
    });
  });

  it("decides and advances in one step, then undoes", () => {
    const start = performance.now();
    const out = decideAndAdvance(items, ["b"], "applied");
    expect(performance.now() - start).toBeLessThan(ADVANCE_BUDGET_MS);
    expect(out.selectedId).toBe("c");
    expect(out.items.find((i) => i.id === "b")?.result).toBe("applied");
    const back = undoDecisions(out.items, ["b"]);
    expect(back.selectedId).toBe("b");
    expect(back.items.find((i) => i.id === "b")?.result).toBeUndefined();
  });

  it("moves past the last of a bulk", () => {
    expect(decideAndAdvance(items, ["a", "b"], "applied").selectedId).toBe("c");
  });
});
