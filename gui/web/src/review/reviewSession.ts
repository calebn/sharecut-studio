import { useEffect, useMemo, useReducer } from "react";
import { type DecisionPlan, planDecision, stepUndecided } from "./advance";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewIntent, ReviewStageProps } from "./ReviewStage";
import type { ReviewEntry } from "./reviewItems";
import type { ReviewFilter } from "./reviewQueueModel";

type DecidedEntry = {
  /** The item carries its `result` and its pre-decision `at`; the content is the snapshot. */
  readonly entry: ReviewEntry;
  /** Decide order. */
  readonly seq: number;
  /** An observed open list lacked this id. */
  readonly left: boolean;
};

export type ReviewSession = {
  readonly decided: ReadonlyMap<string, DecidedEntry>;
  readonly seq: number;
  readonly selectedId: string | null;
  readonly filter: ReviewFilter;
  readonly looksRight: ReadonlySet<string>;
};

export type SessionAction =
  | { type: "select"; id: string | null }
  | { type: "filter"; filter: ReviewFilter }
  | { type: "looksRight"; id: string }
  | { type: "decided"; plan: DecisionPlan; snapshot: readonly ReviewEntry[] }
  /** Failure, a held reply, or the harness Undo. */
  | { type: "revert"; ids: readonly string[] }
  /** Each new open list from the server. */
  | { type: "observed"; open: readonly ReviewEntry[] };

/**
 * The server owns the open list and the session owns decisions. A decided
 * entry overrides the open item, except one that has left and is open again.
 */
export function mergeOpen(
  open: readonly ReviewEntry[],
  decided: ReviewSession["decided"],
): ReviewEntry[] {
  const openIds = new Set(open.map((e) => e.item.id));
  const shown = (id: string) => {
    const hit = decided.get(id);
    return hit && !(hit.left && openIds.has(id)) ? hit : undefined;
  };
  const rest = [...decided.values()]
    .filter((hit) => !openIds.has(hit.entry.item.id))
    .sort((a, b) => a.seq - b.seq)
    .map((hit) => hit.entry);
  return [...open.map((e) => shown(e.item.id)?.entry ?? e), ...rest];
}

const without = <T>(set: ReadonlySet<T>, drop: readonly T[]) =>
  new Set([...set].filter((v) => !drop.includes(v)));

function observe(s: ReviewSession, open: readonly ReviewEntry[]) {
  const openIds = new Set(open.map((e) => e.item.id));
  const dropped: DecidedEntry[] = [];
  const next = new Map<string, DecidedEntry>();
  let changed = false;
  for (const [id, hit] of s.decided) {
    if (hit.left && openIds.has(id)) {
      dropped.push(hit);
      changed = true;
    } else if (!hit.left && !openIds.has(id)) {
      next.set(id, { ...hit, left: true });
      changed = true;
    } else next.set(id, hit);
  }
  const base = changed ? { ...s, decided: next } : s;
  const droppedIds = dropped.map((hit) => hit.entry.item.id);
  const first = dropped.sort((a, b) => a.seq - b.seq)[0];
  if (first) {
    return {
      ...base,
      selectedId: first.entry.item.id,
      looksRight: without(s.looksRight, droppedIds),
    };
  }
  const merged = mergeOpen(open, base.decided);
  const present = merged.some((e) => e.item.id === s.selectedId);
  if (present) return base;
  const selectedId = stepUndecided(
    merged.map((e) => e.item),
    null,
    "forward",
    s.filter,
  );
  return selectedId === s.selectedId ? base : { ...base, selectedId };
}

export function reviewSession(
  s: ReviewSession,
  a: SessionAction,
): ReviewSession {
  switch (a.type) {
    case "select":
      return a.id === s.selectedId ? s : { ...s, selectedId: a.id };
    case "filter":
      return a.filter === s.filter ? s : { ...s, filter: a.filter };
    case "looksRight":
      return s.looksRight.has(a.id)
        ? s
        : { ...s, looksRight: new Set(s.looksRight).add(a.id) };
    case "decided": {
      const fresh = a.plan.decidedIds.filter(
        (id) =>
          !s.decided.has(id) &&
          a.snapshot.some((e) => e.item.id === id && !e.item.result),
      );
      if (fresh.length === 0) return s;
      const decided = new Map(s.decided);
      let seq = s.seq;
      for (const id of fresh) {
        const entry = a.snapshot.find((e) => e.item.id === id);
        const result = a.plan.items.find((i) => i.id === id)?.result;
        if (!entry || !result) continue;
        seq += 1;
        decided.set(id, {
          entry: { ...entry, item: { ...entry.item, result } },
          seq,
          left: false,
        });
      }
      return { ...s, decided, seq, selectedId: a.plan.selectedId };
    }
    case "revert": {
      const hit = a.ids.filter((id) => s.decided.has(id));
      if (hit.length === 0) return s;
      const decided = new Map(s.decided);
      for (const id of hit) decided.delete(id);
      return {
        ...s,
        decided,
        selectedId: hit[0] ?? s.selectedId,
        looksRight: without(s.looksRight, hit),
      };
    }
    case "observed":
      return observe(s, a.open);
  }
}

const NO_CONTENT: ReviewContent = {
  row: { snippet: "", time: "" },
  card: { title: "", time: "" },
};

export function useReviewSession(
  open: readonly ReviewEntry[],
  init: { selectedId?: string; filter?: ReviewFilter } = {},
): {
  props: Pick<
    ReviewStageProps,
    | "items"
    | "content"
    | "selectedId"
    | "filter"
    | "looksRight"
    | "onSelect"
    | "onFilter"
    | "onLooksRight"
  >;
  /** Plans on the merged items, records the ledger and selection in one dispatch. Null when nothing new was decided. */
  decide: (intent: ReviewIntent) => DecisionPlan | null;
  revert: (ids: readonly string[]) => void;
} {
  const [s, dispatch] = useReducer(
    reviewSession,
    undefined,
    (): ReviewSession => {
      const filter = init.filter ?? "all";
      return {
        decided: new Map<string, DecidedEntry>(),
        seq: 0,
        filter,
        selectedId:
          init.selectedId ??
          stepUndecided(
            open.map((e) => e.item),
            null,
            "forward",
            filter,
          ),
        looksRight: new Set<string>(),
      };
    },
  );
  useEffect(() => dispatch({ type: "observed", open }), [open]);

  const merged = useMemo(() => mergeOpen(open, s.decided), [open, s.decided]);
  const items = useMemo(() => merged.map((e) => e.item), [merged]);
  const content = useMemo(() => {
    const byId = new Map(merged.map((e) => [e.item.id, e.content]));
    return (item: { id: string }) => byId.get(item.id) ?? NO_CONTENT;
  }, [merged]);

  return {
    props: {
      items,
      content,
      selectedId: s.selectedId,
      filter: s.filter,
      looksRight: s.looksRight,
      onSelect: (id) => dispatch({ type: "select", id }),
      onFilter: (filter) => dispatch({ type: "filter", filter }),
      onLooksRight: (id) => dispatch({ type: "looksRight", id }),
    },
    decide: ({ ids, result, waive }) => {
      const plan = planDecision(items, ids, result, {
        filter: s.filter,
        waive: !!waive,
      });
      const fresh = plan.decidedIds.some(
        (id) =>
          !s.decided.has(id) && items.some((i) => i.id === id && !i.result),
      );
      if (!fresh) return null;
      dispatch({ type: "decided", plan, snapshot: merged });
      return plan;
    },
    revert: (ids) => dispatch({ type: "revert", ids }),
  };
}
