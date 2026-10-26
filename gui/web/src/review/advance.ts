import { queueOrder, type ReviewItem, type ReviewResult } from "./reviewQueue";

/** A decision has to put the next item on screen inside this budget. */
export const ADVANCE_BUDGET_MS = 100;

export type AdvanceOutcome = {
  items: ReviewItem[];
  /** The next undecided item, or null when the queue is done. */
  selectedId: string | null;
};

/** The undecided item after `currentId` in queue order, wrapping to the start. */
export function nextUndecided(
  items: readonly ReviewItem[],
  currentId: string | null,
): string | null {
  return followingId(queueOrder(items), currentId, null);
}

function followingId(
  before: readonly string[],
  currentId: string | null,
  alive: ReadonlySet<string> | null,
): string | null {
  const at = currentId === null ? -1 : before.indexOf(currentId);
  const rotated = [
    ...before.slice(at + 1),
    ...before.slice(0, Math.max(at, 0)),
  ];
  return (
    rotated.find((id) => id !== currentId && (alive?.has(id) ?? true)) ?? null
  );
}

/** The undecided item before `currentId`, wrapping to the end. */
export function previousUndecided(
  items: readonly ReviewItem[],
  currentId: string | null,
): string | null {
  const all = queueOrder(items);
  const at = currentId === null ? -1 : all.indexOf(currentId);
  const previous = all[(at <= 0 ? all.length : at) - 1];
  return previous === undefined || previous === currentId ? null : previous;
}

/**
 * Records the result and picks the next item in one synchronous step, before
 * any request is sent, so the card can change within `ADVANCE_BUDGET_MS`. The
 * decided row collapses because it leaves the undecided groups.
 */
export function decideAndAdvance(
  items: readonly ReviewItem[],
  id: string,
  result: ReviewResult,
): AdvanceOutcome {
  const before = queueOrder(items);
  const next = items.map((item) =>
    item.id === id ? { ...item, result } : item,
  );
  return {
    items: next,
    selectedId: followingId(before, id, new Set(queueOrder(next))),
  };
}

/** Later moves on without deciding. */
export function later(
  items: readonly ReviewItem[],
  id: string,
): AdvanceOutcome {
  return { items: [...items], selectedId: nextUndecided(items, id) };
}

/** Puts a decided item back, as Undo does, and selects it. */
export function undoDecision(
  items: readonly ReviewItem[],
  id: string,
): AdvanceOutcome {
  return {
    items: items.map((item) =>
      item.id === id ? { ...item, result: undefined } : item,
    ),
    selectedId: id,
  };
}
