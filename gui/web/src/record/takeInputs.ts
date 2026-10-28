import type { TakeClipping } from "./keeper/clipRegions";
import type { SegmentAckRow } from "./saveStatus";
import type { RecordSnapshot, TakeState } from "./types";

export type TakePersonStatus = "waiting" | "saving" | "saved" | "failed";

export type TakeInput = {
  take: number;
  takeIndex: number;
  lengthSec: number;
  open: boolean;
  people: { id: string; name: string; status: TakePersonStatus }[];
  clipTimes: number[];
  landed: boolean;
};

function lengthOf(take: TakeState, snapshot: RecordSnapshot): number {
  if (take.take_index === snapshot.take_index && snapshot.state !== "stopped") {
    return Math.max(0, (snapshot.recording_ms ?? 0) / 1000);
  }
  const end = take.stopped_wall_ms ?? null;
  if (end === null) {
    return 0;
  }
  const paused = take.pauses.reduce((sum, pause) => {
    const resumed = pause.resume_wall_ms ?? end;
    return sum + Math.max(0, resumed - pause.pause_wall_ms);
  }, 0);
  return Math.max(0, (end - take.session_start_wall_ms - paused) / 1000);
}

function statusOf(rows: readonly SegmentAckRow[]): TakePersonStatus {
  if (rows.length === 0) {
    return "waiting";
  }
  if (rows.some((row) => row.land_failed)) {
    return "failed";
  }
  return rows.every((row) => row.file_ack) ? "saved" : "saving";
}

export function takeInputs(
  snapshot: RecordSnapshot | null,
  segments: readonly SegmentAckRow[] = [],
  clipping: TakeClipping | null = null,
): TakeInput[] {
  if (!snapshot) {
    return [];
  }
  const names = new Map(
    snapshot.participants.map((person) => [
      person.participant_id,
      person.display_name,
    ]),
  );
  return (snapshot.takes ?? []).map((take) => {
    const open =
      take.take_index === snapshot.take_index && snapshot.state !== "stopped";
    const people = take.consented_participant_ids.map((id) => {
      const rows = segments.filter(
        (row) =>
          row.take_index === take.take_index && row.participant_id === id,
      );
      return { id, name: names.get(id) ?? id, status: statusOf(rows) };
    });
    const rows = segments.filter((row) => row.take_index === take.take_index);
    return {
      take: take.take_index + 1,
      takeIndex: take.take_index,
      lengthSec: lengthOf(take, snapshot),
      open,
      people,
      clipTimes:
        clipping && clipping.takeIndex === take.take_index
          ? clipping.regions.map((region) => region.startMs / 1000)
          : [],
      landed: rows.length > 0 && rows.every((row) => row.landed),
    };
  });
}
