import type { PendingEditView } from "../types/project";

/** Tracks a pending edit shows on: `track_ids` when set, else `track_id` alone. */
export function pendingEditTrackIds(e: PendingEditView): readonly string[] {
  return e.track_ids?.length ? e.track_ids : [e.track_id];
}
