import { useDawStore } from "../state/dawStore";
import type { HistoryUndo } from "../state/types";

/** Where history sits now. Read it before a mutation and hand it to `historyUndoSince` after. */
export function historyCursor(): number | null {
  return useDawStore.getState().project?.history?.cursor ?? null;
}

/**
 * The toast Undo for the change that just moved history on from `before`.
 * Null when the change left no history step (queued offline, refused, or a
 * no-op), so the toast never offers to undo something else.
 */
export function historyUndoSince(before: number | null): HistoryUndo | null {
  const history = useDawStore.getState().project?.history;
  if (before == null || !history?.can_undo || history.cursor <= before) {
    return null;
  }
  return { cursor: history.cursor };
}
