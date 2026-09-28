import type { PendingEditView } from "../types/project";

/** Name for pending edits whose span was cut away, so they have no place on the timeline. */
export const UNMAPPED_PENDING_TITLE = "Edits in removed audio";

/** `Edits in removed audio (N)`: status chip and empty-inspector heading. */
export function unmappedPendingLabel(count: number): string {
  return `${UNMAPPED_PENDING_TITLE} (${count})`;
}

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
