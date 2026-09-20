import type { PendingEditView } from "../types/project";

/** Pending edits that cannot be drawn on the timeline (cut-away spans). */
export function selectUnmappedPending(
  edits: PendingEditView[] | undefined | null,
): PendingEditView[] {
  if (!edits?.length) {
    return [];
  }
  return edits.filter((e) => !e.mappable);
}
