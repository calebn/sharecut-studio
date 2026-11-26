import {
  HISTORY_ROOT_ID,
  type HistoryEntryId,
  type ProjectView,
} from "../types/project";

type History = ProjectView["history"];

function positions(history: History): Map<string, number> {
  const at = new Map<string, number>();
  if (history.entries && history.entries.length > 0) {
    for (const e of history.entries) at.set(e.id, e.index);
    return at;
  }
  for (const g of history.groups ?? []) {
    if (g.id != null && g.index != null) at.set(g.id, g.index);
    if (g.before_id != null && g.before_index != null)
      at.set(g.before_id, g.before_index);
    if (g.after_id != null && g.after_index != null)
      at.set(g.after_id, g.after_index);
  }
  return at;
}

export type EntryPlace = "undone" | "present" | "unknown";

/** Where the head sits against this entry; "unknown" when the history no longer names it. */
export function entryPlace(
  history: History | null | undefined,
  entryId: HistoryEntryId,
): EntryPlace {
  if (!history) return "unknown";
  const at = positions(history);
  if (at.size > 0) {
    const entry = at.get(entryId);
    if (entry === undefined) return "unknown";
    // The root head sits before every entry and is never listed.
    const head =
      history.head_id === HISTORY_ROOT_ID ? -1 : at.get(history.head_id);
    if (head === undefined) return "unknown";
    return head < entry ? "undone" : "present";
  }
  const group = history.groups?.find((g) => g.after_id === entryId);
  if (group == null) return "unknown";
  return history.head_id === group.before_id ? "undone" : "present";
}

/** True when the head sits before this entry (Ctrl+Z or History stepped back); Redo or a newer edit makes it false. */
export function entryUndone(
  history: History | null | undefined,
  entryId: HistoryEntryId,
): boolean {
  return entryPlace(history, entryId) === "undone";
}
