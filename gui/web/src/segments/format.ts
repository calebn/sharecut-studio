import type { SegmentKind, SegmentRow } from "../api";

export const KIND_LABEL: Record<SegmentKind, string> = {
  intro: "Intro",
  outro: "Outro",
  sponsor: "Sponsor",
  sting: "Sting",
  other: "Other",
};

export function segmentLengthSec(row: SegmentRow): number {
  return row.clips.reduce(
    (end, clip) => Math.max(end, clip.offset_sec + clip.duration_sec),
    0,
  );
}

export function versionTag(row: SegmentRow): string {
  return row.versions.length > 1
    ? `v${row.version} · ${row.versions.length} versions`
    : `v${row.version}`;
}
