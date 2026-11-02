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

/** Tracks a pending edit shows on: `track_ids` when set, else `track_id` alone. */
export function pendingEditTrackIds(e: PendingEditView): readonly string[] {
  return e.track_ids?.length ? e.track_ids : [e.track_id];
}
