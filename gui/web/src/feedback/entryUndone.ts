import type { HistoryEntryId, ProjectView } from "../types/project";

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

/** True when the head sits before this entry (Ctrl+Z or History stepped back); Redo or a newer edit makes it false. */
export function entryUndone(
  history: History | null | undefined,
  entryId: HistoryEntryId,
): boolean {
  if (!history) return false;
  const at = positions(history);
  if (at.size > 0) {
    const entry = at.get(entryId);
    const head = at.get(history.head_id);
    return entry !== undefined && head !== undefined && head < entry;
  }
  const group = history.groups?.find((g) => g.after_id === entryId);
  return group != null && history.head_id === group.before_id;
}
