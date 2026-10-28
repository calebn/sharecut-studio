import { useEffect, useMemo, useReducer } from "react";
import { type DecisionPlan, planDecision, stepUndecided } from "./advance";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewIntent, ReviewStageProps } from "./ReviewStage";
import type { ReviewEntry } from "./reviewItems";
import type { ReviewFilter } from "./reviewQueueModel";

type DecidedEntry = {
  readonly entry: ReviewEntry;
  readonly left: boolean;
};

export type ReviewSession = {
  readonly decided: ReadonlyMap<string, DecidedEntry>;
  readonly selectedId: string | null;
  readonly filter: ReviewFilter;
  readonly looksRight: ReadonlySet<string>;
};

export type SessionStageProps = Pick<
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

export type SessionAction =
  | { type: "select"; id: string | null }
  | { type: "filter"; filter: ReviewFilter }
  | { type: "looksRight"; id: string }
  | { type: "decided"; plan: DecisionPlan; snapshot: readonly ReviewEntry[] }
  | { type: "revert"; ids: readonly string[] }
  | { type: "observed"; open: readonly ReviewEntry[] };

const idOf = (hit: DecidedEntry) => hit.entry.item.id;

/** A decided entry overrides its open item unless it left and is open again. */
export function mergeOpen(
  open: readonly ReviewEntry[],
  decided: ReviewSession["decided"],
): ReviewEntry[] {
  const openIds = new Set(open.map((e) => e.item.id));
  const shown = open.map((e) => {
    const hit = decided.get(e.item.id);
    return hit && !hit.left ? hit.entry : e;
  });
  const rest = [...decided.values()].filter((hit) => !openIds.has(idOf(hit)));
  return [...shown, ...rest.map((hit) => hit.entry)];
}

const without = <T>(set: ReadonlySet<T>, drop: readonly T[]) =>
  new Set([...set].filter((v) => !drop.includes(v)));

function observe(s: ReviewSession, open: readonly ReviewEntry[]) {
  const openIds = new Set(open.map((e) => e.item.id));
  const hits = [...s.decided.values()];
  const back = hits.filter((hit) => hit.left && openIds.has(idOf(hit)));
  const gone = hits.filter((hit) => !hit.left && !openIds.has(idOf(hit)));
  let base = s;
  if (back.length || gone.length) {
    const decided = new Map(s.decided);
    for (const hit of back) decided.delete(idOf(hit));
    for (const hit of gone) decided.set(idOf(hit), { ...hit, left: true });
    base = { ...s, decided };
  }
  const first = back[0];
  if (first) {
    return {
      ...base,
      selectedId: idOf(first),
      looksRight: without(s.looksRight, back.map(idOf)),
    };
  }
  const items = mergeOpen(open, base.decided).map((e) => e.item);
  const selectedId = items.some((i) => i.id === s.selectedId)
    ? s.selectedId
    : stepUndecided(items, null, "forward", s.filter);
  return selectedId === s.selectedId ? base : { ...base, selectedId };
}

export function reviewSession(
  s: ReviewSession,
  a: SessionAction,
): ReviewSession {
  switch (a.type) {
    case "select":
      return { ...s, selectedId: a.id };
    case "filter":
      return { ...s, filter: a.filter };
    case "looksRight":
      return { ...s, looksRight: new Set(s.looksRight).add(a.id) };
    case "decided": {
      const decided = new Map(s.decided);
      for (const id of a.plan.decidedIds) {
        const entry = a.snapshot.find((e) => e.item.id === id);
        const result = a.plan.items.find((i) => i.id === id)?.result;
        if (!entry || !result || entry.item.result || decided.has(id)) continue;
        const item = { ...entry.item, result };
        decided.set(id, { entry: { ...entry, item }, left: false });
      }
      return decided.size === s.decided.size
        ? s
        : { ...s, decided, selectedId: a.plan.selectedId };
    }
    case "revert": {
      const hit = a.ids.filter((id) => s.decided.has(id));
      if (hit.length === 0) return s;
      const back = hit.filter((id) => !s.decided.get(id)?.left);
      const decided = new Map(s.decided);
      for (const id of hit) decided.delete(id);
      return {
        ...s,
        decided,
        selectedId: back[0] ?? s.selectedId,
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
  props: SessionStageProps;
  decide: (intent: ReviewIntent) => DecisionPlan | null;
  revert: (ids: readonly string[]) => void;
} {
  const [s, dispatch] = useReducer(reviewSession, undefined, () => {
    const filter = init.filter ?? "all";
    const items = open.map((e) => e.item);
    return {
      decided: new Map(),
      filter,
      looksRight: new Set(),
      selectedId:
        init.selectedId ?? stepUndecided(items, null, "forward", filter),
    } satisfies ReviewSession;
  });
  useEffect(() => dispatch({ type: "observed", open }), [open, s.decided]);

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
      const fresh = plan.decidedIds.some((id) =>
        items.some((i) => i.id === id && !i.result),
      );
      if (!fresh) return null;
      dispatch({ type: "decided", plan, snapshot: merged });
      return plan;
    },
    revert: (ids) => dispatch({ type: "revert", ids }),
  };
}
