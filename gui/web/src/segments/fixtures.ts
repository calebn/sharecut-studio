import type { DamagedSegmentRow, SegmentListRow, SegmentRow } from "../api";

export function segment(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: "intro-9f3a",
    name: "Cold open",
    kind: "intro",
    version: 1,
    versions: [1],
    clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
    ...over,
  };
}

export const HEALTHY: SegmentRow = segment();

export const MULTI_VERSION: SegmentRow = segment({
  id: "sponsor-21bc",
  name: "Acme sponsor read",
  kind: "sponsor",
  version: 3,
  versions: [1, 2, 3],
  clips: [
    { audio: "a.flac", offset_sec: 0, duration_sec: 20 },
    { audio: "b.flac", offset_sec: 20, duration_sec: 14.6 },
  ],
});

export const DAMAGED: DamagedSegmentRow = {
  id: "outro-77de",
  version: 2,
  damaged: true,
  problem: "Version 2 has no readable audio: clips/outro.flac is missing.",
  code: "segment_media_invalid",
};

export const LIBRARY: SegmentListRow[] = [HEALTHY, MULTI_VERSION, DAMAGED];

export const LONG_NAME = segment({
  id: "long-1",
  name: "A very long segment name that keeps going so the row has to wrap under text zoom without a horizontal scrollbar",
  kind: "other",
});
