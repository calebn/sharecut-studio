import {
  hostUploadLine,
  type RecordParticipant,
  type RecordSegmentAck,
} from "./types";

export function HostUploadRoster({
  participants,
  segments,
  stopped,
}: {
  participants: RecordParticipant[];
  segments: RecordSegmentAck[];
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
    {
      acked: number;
      total: number;
      totalKnown: boolean;
      fileAck: boolean;
      landed: boolean;
      landFailed: boolean;
      seen: boolean;
    }
  >();
  for (const id of ids) {
    byId.set(id, {
      acked: 0,
      total: 0,
      totalKnown: true,
      fileAck: false,
      landed: false,
      landFailed: false,
      seen: false,
    });
  }
  for (const row of segments) {
    const slot = byId.get(row.participant_id) ?? {
      acked: 0,
      total: 0,
      totalKnown: true,
      fileAck: false,
      landed: false,
      landFailed: false,
      seen: false,
    };
    slot.acked += row.file_ack
      ? (row.expected_parts ?? row.acked_parts.length)
      : row.acked_parts.length;
    if (row.expected_parts != null) {
      slot.total += row.expected_parts;
    } else {
      slot.totalKnown = false;
    }
    const ack = Boolean(row.file_ack);
    slot.fileAck = slot.seen ? slot.fileAck && ack : ack;
    slot.landed = slot.seen
      ? slot.landed && Boolean(row.landed)
      : Boolean(row.landed);
    slot.landFailed = slot.landFailed || Boolean(row.land_failed);
    slot.seen = true;
    byId.set(row.participant_id, slot);
  }
  const lines = [...byId.entries()].map(([id, slot]) => ({
    id,
    text: hostUploadLine(
      names.get(id) || id,
      slot.fileAck,
      slot.acked,
      slot.seen && slot.totalKnown ? slot.total : null,
      slot.landed,
      slot.landFailed,
    ),
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
