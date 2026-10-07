import { capitalize, plural } from "../utils/format";
import type { RecordParticipant, RecordSegmentAck } from "./types";

/**
 * Where one segment of a participant's full-quality recording stands. A
 * segment is saved once the project holds the verified file (file ACK); landing
 * it on the timeline is a separate step the Land control reports.
 */
export type SaveState = "saving" | "saved";

export const SAVE_STATE_COPY = {
  saving: "Saving to project…",
  saved: "Saved to project",
} as const satisfies Record<SaveState, string>;

export type SegmentSave = {
  /** Zero-based, as the server counts takes. */
  take: number;
  /** Zero-based, as the server counts segments. */
  segment: number;
  state: SaveState;
  /** Chunks acknowledged and expected, while the total is known and saving. */
  chunks: { acked: number; total: number } | null;
  landFailed: boolean;
};

/** One host status row: a participant's segment with its take and segment index. */
export type SegmentAckRow = RecordSegmentAck & {
  take_index: number;
  segment_index: number;
};

export function segmentSaveFromAck(row: SegmentAckRow): SegmentSave {
  const saved = Boolean(row.file_ack);
  return {
    take: row.take_index,
    segment: row.segment_index,
    state: saved ? "saved" : "saving",
    chunks:
      !saved && row.expected_parts != null
        ? { acked: row.acked_parts.length, total: row.expected_parts }
        : null,
    landFailed: Boolean(row.land_failed),
  };
}

/** `take 1 segment 2`, one-based for people. */
export function segmentLabel(
  save: Pick<SegmentSave, "take" | "segment">,
): string {
  return `take ${save.take + 1} segment ${save.segment + 1}`;
}

/** The status after the colon: the state, then what else the person can act on. */
export function segmentStatusText(save: SegmentSave): string {
  if (save.state === "saved") {
    return save.landFailed
      ? `${SAVE_STATE_COPY.saved}. Landing failed. Use Retry land.`
      : SAVE_STATE_COPY.saved;
  }
  return save.chunks
    ? `${SAVE_STATE_COPY.saving} ${save.chunks.acked} of ${save.chunks.total} ${plural(save.chunks.total, "chunk")}`
    : SAVE_STATE_COPY.saving;
}

export type SaveLine = { key: string; text: string };

/**
 * One line per participant segment for the host, in roster order. A recorded
 * participant with nothing uploaded yet reads as saving, and a participant with
 * several segments gets each one named so the lines stay distinguishable.
 */
export function hostSaveLines(
  participants: readonly RecordParticipant[],
  segments: readonly SegmentAckRow[],
): SaveLine[] {
  const names = new Map(
    participants
      .filter((person) => person.role !== "producer")
      .map((person) => [person.participant_id, person.display_name]),
  );
  const byParticipant = new Map<string, SegmentSave[]>(
    [...names.keys()].map((id) => [id, []]),
  );
  for (const row of segments) {
    const saves = byParticipant.get(row.participant_id) ?? [];
    saves.push(segmentSaveFromAck(row));
    byParticipant.set(row.participant_id, saves);
  }
  const lines: SaveLine[] = [];
  for (const [id, saves] of byParticipant) {
    const name = names.get(id) || id;
    if (saves.length === 0) {
      lines.push({ key: id, text: `${name}: ${SAVE_STATE_COPY.saving}` });
      continue;
    }
    const ordered = [...saves].sort(
      (a, b) => a.take - b.take || a.segment - b.segment,
    );
    for (const save of ordered) {
      const who = ordered.length > 1 ? `${name}, ${segmentLabel(save)}` : name;
      lines.push({
        key: `${id}:${save.take}:${save.segment}`,
        text: `${who}: ${segmentStatusText(save)}`,
      });
    }
  }
  return lines;
}

/** The signed-in participant's own segments, one line each. */
export function ownSaveLines(segments: readonly SegmentSave[]): SaveLine[] {
  return segments.map((save) => ({
    key: `${save.take}:${save.segment}`,
    text: `${capitalize(segmentLabel(save))}: ${segmentStatusText(save)}`,
  }));
}
