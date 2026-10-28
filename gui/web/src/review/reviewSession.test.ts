import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { planDecision } from "./advance";
import type { ReviewEntry } from "./reviewItems";
import type { ReviewItem } from "./reviewQueueModel";
import {
  mergeOpen,
  type ReviewSession,
  reviewSession,
  useReviewSession,
} from "./reviewSession";

const entry = (id: string, at: number, over: Partial<ReviewItem> = {}) =>
  ({
    item: { id, kind: "filler", at, savedSeconds: 0.5, ...over },
    content: { row: { snippet: id, time: "" }, card: { title: id, time: "" } },
  }) satisfies ReviewEntry;

const A = entry("a", 1);
const B = entry("b", 2);
const C = entry("c", 3);
const OPEN = [A, B, C];

const start = (selectedId: string | null = "a"): ReviewSession => ({
  decided: new Map(),
  seq: 0,
  selectedId,
  filter: "all",
  looksRight: new Set(),
});

const decide = (s: ReviewSession, ids: string[], open = OPEN) => {
  const merged = mergeOpen(open, s.decided);
  const plan = planDecision(
    merged.map((e) => e.item),
    ids,
    "applied",
  );
  return reviewSession(s, { type: "decided", plan, snapshot: merged });
};

const ids = (list: readonly ReviewEntry[]) => list.map((e) => e.item.id);
const resultOf = (list: readonly ReviewEntry[], id: string) =>
  list.find((e) => e.item.id === id)?.item.result;

describe("decided", () => {
  it("records the ids, their order and the next selection", () => {
    const s = decide(start(), ["a", "b"]);
    expect([...s.decided.keys()]).toEqual(["a", "b"]);
    expect(s.decided.get("b")?.seq).toBe(2);
    expect(s.selectedId).toBe("c");
    expect(resultOf(mergeOpen(OPEN, s.decided), "a")).toBe("applied");
  });

  it("is a no-op on an id that is already decided", () => {
    const once = decide(start(), ["a"]);
    expect(decide(once, ["a"])).toBe(once);
  });

  it("ignores an open item that already carries a result", () => {
    const done = entry("d", 0, { result: "kept" });
    const s = decide(start(null), ["d"], [done, ...OPEN]);
    expect(s.decided.size).toBe(0);
  });

  it("freezes the pre-decision item and content", () => {
    const s = decide(start(), ["a"]);
    expect(s.decided.get("a")?.entry.item.at).toBe(1);
    expect(s.decided.get("a")?.entry.content.card.title).toBe("a");
  });
});

describe("observed", () => {
  it("keeps a Decided row after its id leaves the open list", () => {
    let s = decide(start(), ["a"]);
    s = reviewSession(s, { type: "observed", open: [B, C] });
    expect(s.decided.get("a")?.left).toBe(true);
    const merged = mergeOpen([B, C], s.decided);
    expect(ids(merged)).toEqual(["b", "c", "a"]);
    expect(resultOf(merged, "a")).toBe("applied");
  });

  it("keeps the entry decided while a snapshot still lists the id", () => {
    let s = decide(start(), ["a"]);
    s = reviewSession(s, { type: "observed", open: OPEN });
    expect(s.decided.get("a")?.left).toBe(false);
    expect(resultOf(mergeOpen(OPEN, s.decided), "a")).toBe("applied");
  });

  it("drops an entry that left and is open again, and selects it", () => {
    let s = decide(start(), ["a"]);
    s = reviewSession(s, { type: "observed", open: [B, C] });
    s = reviewSession(s, { type: "select", id: "c" });
    s = reviewSession(s, { type: "observed", open: OPEN });
    expect(s.decided.size).toBe(0);
    expect(s.selectedId).toBe("a");
    expect(resultOf(mergeOpen(OPEN, s.decided), "a")).toBeUndefined();
  });

  it("renders a restored id as open before the observed dispatch", () => {
    let s = decide(start(), ["a"]);
    s = reviewSession(s, { type: "observed", open: [B, C] });
    expect(resultOf(mergeOpen(OPEN, s.decided), "a")).toBeUndefined();
  });

  it("selects the lowest decide order among restored ids and clears their marks", () => {
    let s = decide(start(), ["b", "a"]);
    s = reviewSession(s, { type: "looksRight", id: "a" });
    s = reviewSession(s, { type: "looksRight", id: "c" });
    s = reviewSession(s, { type: "observed", open: [C] });
    s = reviewSession(s, { type: "observed", open: OPEN });
    expect(s.selectedId).toBe("b");
    expect([...s.looksRight]).toEqual(["c"]);
  });

  it("is idempotent for the same snapshot", () => {
    const s = decide(start(), ["a"]);
    const once = reviewSession(s, { type: "observed", open: [B, C] });
    expect(reviewSession(once, { type: "observed", open: [B, C] })).toBe(once);
    const again = reviewSession(start(), { type: "observed", open: OPEN });
    expect(again.selectedId).toBe("a");
    expect(reviewSession(again, { type: "observed", open: OPEN })).toBe(again);
  });

  it("moves selection on when the selected id vanishes", () => {
    const s = reviewSession(start("a"), {
      type: "observed",
      open: [B, C],
    });
    expect(s.selectedId).toBe("b");
  });

  it("selects the first undecided item when nothing was selected", () => {
    const s = reviewSession(start(null), { type: "observed", open: OPEN });
    expect(s.selectedId).toBe("a");
  });
});

describe("revert", () => {
  it("drops the entry and its Looks-right mark, then selects it", () => {
    let s = decide(start(), ["a", "b"]);
    s = reviewSession(s, { type: "looksRight", id: "a" });
    s = reviewSession(s, { type: "revert", ids: ["a", "b"] });
    expect(s.decided.size).toBe(0);
    expect(s.looksRight.size).toBe(0);
    expect(s.selectedId).toBe("a");
  });

  it("is a no-op for an id that is not decided", () => {
    const s = start();
    expect(reviewSession(s, { type: "revert", ids: ["zzz"] })).toBe(s);
  });
});

describe("select, filter and looksRight", () => {
  it("repeat the same value as a no-op", () => {
    const s = reviewSession(start(), { type: "looksRight", id: "a" });
    expect(reviewSession(s, { type: "looksRight", id: "a" })).toBe(s);
    expect(reviewSession(s, { type: "select", id: "a" })).toBe(s);
    expect(reviewSession(s, { type: "filter", filter: "all" })).toBe(s);
    expect(
      reviewSession(s, { type: "filter", filter: "comments" }).filter,
    ).toBe("comments");
  });
});

describe("mergeOpen", () => {
  it("lists decided entries that are not open after the open ones, in decide order", () => {
    let s = decide(start(), ["c", "a"]);
    s = reviewSession(s, { type: "observed", open: [B] });
    expect(ids(mergeOpen([B], s.decided))).toEqual(["b", "c", "a"]);
  });
});

describe("useReviewSession", () => {
  it("decides on the merged items and reverts", () => {
    const { result } = renderHook(() => useReviewSession(OPEN));
    expect(result.current.props.selectedId).toBe("a");
    let plan: ReturnType<typeof result.current.decide> = null;
    act(() => {
      plan = result.current.decide({ ids: ["a"], result: "applied" });
    });
    expect(plan).not.toBeNull();
    expect(result.current.props.selectedId).toBe("b");
    expect(result.current.props.items.find((i) => i.id === "a")?.result).toBe(
      "applied",
    );
    act(() => {
      expect(
        result.current.decide({ ids: ["a"], result: "applied" }),
      ).toBeNull();
    });
    act(() => result.current.revert(["a"]));
    expect(result.current.props.selectedId).toBe("a");
    expect(result.current.props.items.find((i) => i.id === "a")?.result).toBe(
      undefined,
    );
  });

  it("serves the snapshot content of a decided entry", () => {
    const { result, rerender } = renderHook(
      ({ open }) => useReviewSession(open),
      { initialProps: { open: OPEN } },
    );
    act(() => {
      result.current.decide({ ids: ["a"], result: "kept" });
    });
    rerender({ open: [B, C] });
    const decided = result.current.props.items.find((i) => i.id === "a");
    expect(decided?.result).toBe("kept");
    expect(result.current.props.content(decided as ReviewItem).card.title).toBe(
      "a",
    );
  });
});
