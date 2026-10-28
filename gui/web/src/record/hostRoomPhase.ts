import type { RoomPhase } from "../system/roomPhase";
import { recordingClockMs } from "./clock";
import type { SegmentAckRow } from "./saveStatus";
import type { RecordSnapshot } from "./types";

type PhaseOptions = {
  elapsedSinceSnapshotMs?: number;
  dropped?: boolean;
  segments?: readonly SegmentAckRow[];
};

export function takeSaveCounts(
  snapshot: RecordSnapshot,
  segments: readonly SegmentAckRow[],
): { saved: number; total: number } {
  const roster = new Set(
    snapshot.takes?.find((take) => take.take_index === snapshot.take_index)
      ?.consented_participant_ids ?? [],
  );
  const rows = segments.filter(
    (row) =>
      row.take_index === snapshot.take_index &&
      (roster.size === 0 || roster.has(row.participant_id)),
  );
  const people = new Set(rows.map((row) => row.participant_id));
  const done = new Set(
    [...people].filter((id) =>
      rows
        .filter((row) => row.participant_id === id)
        .every((row) => row.file_ack),
    ),
  );
  return { saved: done.size, total: Math.max(roster.size, people.size) };
}

export function hostRoomPhase(
  snapshot: RecordSnapshot | null,
  options: PhaseOptions = {},
): RoomPhase {
  if (!snapshot) {
    return { kind: "waiting" };
  }
  const live = snapshot.state === "recording" || snapshot.state === "paused";
  if (options.dropped && live) {
    return { kind: "reconnecting" };
  }
  const clockSec =
    recordingClockMs(snapshot, options.elapsedSinceSnapshotMs ?? 0) / 1000;
  switch (snapshot.state) {
    case "lobby": {
      const left = snapshot.countdown_left_ms ?? 0;
      if (snapshot.room_tone && left > 0) {
        const secondsLeft = Math.min(3, Math.max(1, Math.ceil(left / 1000)));
        return { kind: "countdown", secondsLeft: secondsLeft as 3 | 2 | 1 };
      }
      return { kind: "waiting" };
    }
    case "recording":
      return { kind: "live", take: snapshot.take_index + 1, clockSec };
    case "paused":
      return { kind: "paused", clockSec };
    case "stopped": {
      if (snapshot.take_index < 0) {
        return { kind: "waiting" };
      }
      const { saved, total } = takeSaveCounts(snapshot, options.segments ?? []);
      return total > 0 && saved >= total
        ? { kind: "saved" }
        : { kind: "saving", savedPeople: saved, totalPeople: total };
    }
  }
}
