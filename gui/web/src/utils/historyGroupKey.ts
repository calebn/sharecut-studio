import type { HistoryGroup } from "../types/project";

/** Stable row key: the entry id (after-entry for mutations); indexes only as a fallback. */
export function historyGroupKey(g: HistoryGroup, i: number): string {
  if (g.kind === "mutation") {
    return g.after_id
      ? `m-${g.after_id}`
      : `m-${g.before_index}-${g.after_index}`;
  }
  return g.id ? `s-${g.id}` : `s-${g.index ?? i}`;
}
