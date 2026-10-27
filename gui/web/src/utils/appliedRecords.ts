import type { AppliedEditRecord } from "../types/project";

export function isMuteRecord(record: AppliedEditRecord): boolean {
  return (
    record.params?.mute === true ||
    (record.operation === "edit_selected_range" &&
      record.params?.action === "mute")
  );
}

const EDGE_OPERATIONS: ReadonlySet<string> = new Set([
  "trim_clip_edge",
  "split_clips_at",
  "approve_split",
  "roll_clip_join",
  "fill_with_room_tone",
  "move_clips",
]);

/** True when the record took time out, so it leaves a seam that Keep can restore. A mute, trim, split, roll, fill or move leaves an edge. */
export function isRemovalRecord(record: AppliedEditRecord): boolean {
  return !isMuteRecord(record) && !EDGE_OPERATIONS.has(record.operation);
}
