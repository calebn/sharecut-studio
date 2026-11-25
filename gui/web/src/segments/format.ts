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

export function formatLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

export function versionTag(row: SegmentRow): string {
  return row.versions.length > 1
    ? `v${row.version} · ${row.versions.length} versions`
    : `v${row.version}`;
}
