import { isDamagedSegment, type SegmentListRow, type SegmentRow } from "../api";

export const GONE_NOTE =
  "This segment is no longer in the library, or can't be read. Remove it to save the kit.";

export function startOrderNote(name: string, other: string): string {
  return `Start entries apply one after another, so ${name} will land ahead of ${other}. Set one of them to End, or leave it if that order is what you want.`;
}

export function healthySegments(
  rows: readonly SegmentListRow[] | null,
): SegmentRow[] {
  return (rows ?? []).filter(
    (row): row is SegmentRow => !isDamagedSegment(row),
  );
}

export function unreadableNote(count: number): string {
  return count === 1
    ? "1 segment can't be read and isn't listed."
    : `${count} segments can't be read and aren't listed.`;
}
