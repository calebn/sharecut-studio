import { type TakeClipping, takeRelativeMs } from "./keeper/clipRegions";
import type { SegmentAckRow } from "./saveStatus";

/** One person's clipping in one take, from the spans their uploaded segments carried; null when none. */
export function clippingFromRows(
  rows: readonly SegmentAckRow[],
  takeIndex: number,
  participantId: string,
): TakeClipping | null {
  const regions: TakeClipping["regions"] = [];
  let truncated = false;
  for (const row of rows) {
    if (row.take_index !== takeIndex || row.participant_id !== participantId) {
      continue;
    }
    const spans = row.clipping_regions ?? [];
    regions.push(
      ...takeRelativeMs(
        row.segment_index,
        row.join_offset_ms ?? 0,
        spans.map(([startMs, endMs]) => ({ startMs, endMs })),
      ),
    );
    if (row.clipping_truncated) {
      truncated = true;
    }
  }
  if (regions.length === 0) {
    return null;
  }
  regions.sort((a, b) => a.startMs - b.startMs);
  return {
    takeIndex,
    regions,
    known: true,
    ...(truncated ? { truncated: true } : {}),
  };
}
