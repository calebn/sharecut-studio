import type { ClipRow } from "../types/project";

/** Same-lane source IDs or opaque file identities match `clips_ops._same_recording`. */
export function sameRecording(a: ClipRow, b: ClipRow): boolean {
  return (
    a.source_id === b.source_id ||
    (a.recording_key != null && a.recording_key === b.recording_key)
  );
}
