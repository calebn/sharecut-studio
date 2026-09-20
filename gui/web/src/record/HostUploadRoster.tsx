import { hostUploadLine, type RecordParticipant } from "./types";

export function HostUploadRoster({
  participants,
  segments,
  stopped,
}: {
  participants: RecordParticipant[];
  segments: Array<{
    participant_id: string;
    acked_parts: number[];
    file_ack?: boolean;
  }>;
  stopped: boolean;
}) {
  const recorded = participants.filter((person) => person.role !== "producer");
  const ids = new Set([
    ...recorded.map((person) => person.participant_id),
    ...segments.map((row) => row.participant_id),
  ]);
  if (ids.size === 0) {
    return null;
  }
  const names = new Map(
    recorded.map((person) => [person.participant_id, person.display_name]),
  );
  const byId = new Map<
    string,
    { acked: number; fileAck: boolean; seen: boolean }
  >();
  for (const id of ids) {
    byId.set(id, { acked: 0, fileAck: false, seen: false });
  }
  for (const row of segments) {
    const slot = byId.get(row.participant_id) ?? {
      acked: 0,
      fileAck: false,
      seen: false,
    };
    slot.acked += row.acked_parts.length;
    const ack = Boolean(row.file_ack);
    slot.fileAck = slot.seen ? slot.fileAck && ack : ack;
    slot.seen = true;
    byId.set(row.participant_id, slot);
  }
  const lines = [...byId.entries()].map(([id, slot]) => ({
    id,
    text: hostUploadLine(names.get(id) || id, slot.fileAck, slot.acked),
  }));
  if (
    !stopped &&
    segments.length === 0 &&
    lines.every((row) => row.text.endsWith("waiting to upload."))
  ) {
    return null;
  }
  return (
    <ul aria-label="Upload status" className="record-roster">
      {lines.map((row) => (
        <li key={row.id}>{row.text}</li>
      ))}
    </ul>
  );
}
