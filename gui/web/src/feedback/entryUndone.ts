import type { HistoryEntryId, ProjectView } from "../types/project";

/** True when the head sits before this entry (Ctrl+Z or History stepped back); Redo or a newer edit makes it false. */
export function entryUndone(
  history: ProjectView["history"] | null | undefined,
  entryId: HistoryEntryId,
): boolean {
  const entries = history?.entries;
  if (entries && entries.length > 0) {
    const at = entries.findIndex((e) => e.id === entryId);
    const head = entries.findIndex((e) => e.id === history?.head_id);
    return at >= 0 && head >= 0 && head < at;
  }
  const group = history?.groups?.find((g) => g.after_id === entryId);
  return group != null && history?.head_id === group.before_id;
}
