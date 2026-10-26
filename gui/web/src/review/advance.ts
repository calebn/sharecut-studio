import {
  decisionMessage,
  filterItems,
  fullOrder,
  type ReviewFilter,
  type ReviewItem,
  type ReviewResult,
} from "./reviewQueue";

type Direction = "forward" | "backward";

/**
 * The undecided item after (or before) `id` among the visible ones, wrapping.
 * `id` itself is the last candidate, so a lone undecided item stays selected.
 * A decided `id` keeps its place in the order.
 */
export function stepUndecided(
  items: readonly ReviewItem[],
  id: string | null,
  direction: Direction,
  filter: ReviewFilter = "all",
): string | null {
  const visible = new Set(filterItems(items, filter).map((item) => item.id));
  const order = fullOrder(items);
  const at = order.findIndex((item) => item.id === id);
  const walk =
    direction === "forward"
      ? [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0) + 1)]
      : [
          ...order.slice(0, at === -1 ? order.length : at).reverse(),
          ...order.slice(at === -1 ? order.length : at).reverse(),
        ];
  return (
    walk.find((item) => item.result === undefined && visible.has(item.id))
      ?.id ?? null
  );
}

export type DecisionPlan = {
  items: ReviewItem[];
  /** The next undecided item, or null when nothing visible is left. */
  selectedId: string | null;
  /** Every id the step decided, the transcript check included. */
  decidedIds: string[];
  message: string;
};

type PlanOptions = {
  filter?: ReviewFilter;
  /** Cut anyway: the transcript check counts as checked. */
  waive?: boolean;
};

const openOf = (items: readonly ReviewItem[], kind: ReviewItem["kind"]) =>
  items.filter((item) => item.kind === kind && item.result === undefined);

/**
 * Decides `ids` and picks the next item in one synchronous step, before any
 * request is sent, so the card can change within 100 ms. The transcript check
 * is decided with the last unsure word or with Cut anyway; other checks stay.
 */
export function planDecision(
  items: readonly ReviewItem[],
  ids: readonly string[],
  result: ReviewResult,
  { filter = "all", waive = false }: PlanOptions = {},
): DecisionPlan {
  const settled = new Set(ids);
  const wordsLeft = openOf(items, "unsure-word").some(
    (item) => !settled.has(item.id),
  );
  const closesWords =
    ids.some((id) => items.find((i) => i.id === id)?.kind === "unsure-word") &&
    !wordsLeft;
  const checks =
    waive || closesWords
      ? openOf(items, "check")
          .filter((item) => item.transcript)
          .map((item) => item.id)
      : [];
  const decidedIds = [...ids, ...checks.filter((id) => !settled.has(id))];
  const next = items.map((item) =>
    decidedIds.includes(item.id) ? { ...item, result } : item,
  );
  const last = fullOrder(items)
    .reverse()
    .find((item) => ids.includes(item.id));
  return {
    items: next,
    selectedId: stepUndecided(next, last?.id ?? null, "forward", filter),
    decidedIds,
    message: decisionMessage(items, ids, result),
  };
}

export function undoDecisions(
  items: readonly ReviewItem[],
  ids: readonly string[],
): { items: ReviewItem[]; selectedId: string | null } {
  return {
    items: items.map((item) =>
      ids.includes(item.id) ? { ...item, result: undefined } : item,
    ),
    selectedId: ids[0] ?? null,
  };
}
