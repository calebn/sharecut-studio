import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { type DecisionPlan, planDecision, stepUndecided } from "./advance";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewIntent } from "./ReviewStage";
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

export type SessionStageProps = ReturnType<typeof useReviewSession>["props"];

export type SessionAction =
  | { type: "select"; id: string | null }
  | { type: "filter"; filter: ReviewFilter }
  | { type: "looksRight"; id: string }
  | { type: "decided"; plan: DecisionPlan; snapshot: readonly ReviewEntry[] }
  | {
      type: "revert";
      ids: readonly string[];
      from?: string | null;
      /** Rows whose looks-right mark goes too, such as cuts a word had freed. */
      hold?: readonly string[];
    }
  | { type: "observed"; open: readonly ReviewEntry[] };

const idOf = (hit: DecidedEntry) => hit.entry.item.id;

/** A decided entry overrides its open item unless it left and is open again. */
export function mergeOpen(
  open: readonly ReviewEntry[],
  decided: ReviewSession["decided"],
): ReviewEntry[] {
  const openIds = new Set(open.map((e) => e.item.id));
  return [
    ...open.map((e) => {
      const hit = decided.get(e.item.id);
      return hit && !hit.left ? hit.entry : e;
    }),
    ...[...decided.values()]
      .filter((hit) => !openIds.has(idOf(hit)))
      .map((hit) => hit.entry),
  ];
}

function without<T>(set: ReadonlySet<T>, drop: readonly T[]) {
  return new Set([...set].filter((v) => !drop.includes(v)));
}

function observe(s: ReviewSession, open: readonly ReviewEntry[]) {
  const openIds = new Set(open.map((e) => e.item.id));
  const hits = [...s.decided.values()];
  const back = hits.filter((hit) => hit.left && openIds.has(idOf(hit)));
  const gone = hits.filter((hit) => !hit.left && !openIds.has(idOf(hit)));
  const decided = new Map(s.decided);
  for (const hit of back) decided.delete(idOf(hit));
  for (const hit of gone) decided.set(idOf(hit), { ...hit, left: true });
  const base = back.length || gone.length ? { ...s, decided } : s;
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
      const hit = a.ids.filter((id) => s.decided.get(id)?.left === false);
      const hold = a.hold ?? [];
      if (hit.length === 0)
        return hold.some((id) => s.looksRight.has(id))
          ? { ...s, looksRight: without(s.looksRight, hold) }
          : s;
      const decided = new Map(s.decided);
      for (const id of hit) decided.delete(id);
      const follow = a.from === undefined || a.from === s.selectedId;
      return {
        ...s,
        decided,
        selectedId: follow ? hit[0] : s.selectedId,
        looksRight: without(s.looksRight, [...hit, ...hold]),
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
) {
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
  const claimed = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    claimed.current = new Set(s.decided.keys());
  }, [s.decided]);

  /** `from` is the selection the decision moved to; the row takes it back only while it is still there. */
  const revert = useCallback(
    (ids: readonly string[], from?: string | null, hold?: readonly string[]) =>
      dispatch({ type: "revert", ids, from, hold }),
    [],
  );
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
      onSelect: (id: string | null) => dispatch({ type: "select", id }),
      onFilter: (filter: ReviewFilter) => dispatch({ type: "filter", filter }),
      onLooksRight: (id: string) => dispatch({ type: "looksRight", id }),
    },
    decide: ({ ids, result, waive }: ReviewIntent): DecisionPlan | null => {
      const view = items.map((i) =>
        claimed.current.has(i.id) && !i.result ? { ...i, result } : i,
      );
      const fresh = ids.filter((id) =>
        view.some((i) => i.id === id && !i.result),
      );
      if (fresh.length === 0) return null;
      const plan = planDecision(view, fresh, result, {
        filter: s.filter,
        waive: !!waive,
      });
      for (const id of plan.decidedIds) claimed.current.add(id);
      dispatch({ type: "decided", plan, snapshot: merged });
      return plan;
    },
    revert,
  };
}
