import { hostSaveLines, type SegmentAckRow } from "./saveStatus";
import type { RecordParticipant } from "./types";

export function HostUploadRoster({
  participants,
  segments,
  stopped,
}: {
  participants: RecordParticipant[];
  segments: SegmentAckRow[];
  stopped: boolean;
}) {
  // Before Stop with no saved segments, every row would read "Saving to project…": hide the roster.
  if (!stopped && segments.length === 0) {
    return null;
  }
  const lines = hostSaveLines(participants, segments);
  if (lines.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Full-quality recording status" className="record-roster">
      {lines.map((row) => (
        <li key={row.key}>{row.text}</li>
      ))}
    </ul>
  );
}
