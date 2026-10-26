import { fullOrder, type ReviewItem, type ReviewResult } from "./reviewQueue";

/** A decision has to put the next item on screen inside this budget. */
export const ADVANCE_BUDGET_MS = 100;

export type AdvanceOutcome = {
  items: ReviewItem[];
  /** The next undecided item, or null when the queue is done. */
  selectedId: string | null;
};

/** The undecided item after `id`, wrapping to the start. A decided `id` keeps its place. */
export function nextUndecided(
  items: readonly ReviewItem[],
  id: string | null,
): string | null {
  const order = fullOrder(items);
  const at = order.findIndex((item) => item.id === id);
  const rotated = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))];
  return (
    rotated.find((item) => item.result === undefined && item.id !== id)?.id ??
    null
  );
}

/** The undecided item before `id`, wrapping to the end. */
export function previousUndecided(
  items: readonly ReviewItem[],
  id: string | null,
): string | null {
  const order = fullOrder(items);
  const at = order.findIndex((item) => item.id === id);
  const before = at === -1 ? order.length : at;
  const back = [
    ...order.slice(0, before).reverse(),
    ...order.slice(before + 1).reverse(),
  ];
  return (
    back.find((item) => item.result === undefined && item.id !== id)?.id ?? null
  );
}

/**
 * Records the results and picks the next item in one synchronous step, before
 * any request is sent, so the card can change within `ADVANCE_BUDGET_MS`.
 */
export function decideAndAdvance(
  items: readonly ReviewItem[],
  ids: readonly string[],
  result: ReviewResult,
): AdvanceOutcome {
  const next = items.map((item) =>
    ids.includes(item.id) ? { ...item, result } : item,
  );
  const last = fullOrder(items)
    .reverse()
    .find((item) => ids.includes(item.id));
  return { items: next, selectedId: nextUndecided(next, last?.id ?? null) };
}

/** Reverts the decisions and selects the first of them. */
export function undoDecisions(
  items: readonly ReviewItem[],
  ids: readonly string[],
): AdvanceOutcome {
  return {
    items: items.map((item) =>
      ids.includes(item.id) ? { ...item, result: undefined } : item,
    ),
    selectedId: ids[0] ?? null,
  };
}
