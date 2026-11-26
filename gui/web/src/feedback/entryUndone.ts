import type { HistoryEntryId, ProjectView } from "../types/project";

/** True when Ctrl+Z moved the head back exactly one step from this entry (Redo or a newer edit makes it false). */
export function entryUndone(
  history: ProjectView["history"] | null | undefined,
  entryId: HistoryEntryId,
): boolean {
  const group = history?.groups?.find((g) => g.after_id === entryId);
  return group != null && history?.head_id === group.before_id;
}
