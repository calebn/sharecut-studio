import type { ClipRow, TrackView } from "../types/project";
import { sourceSecInClipToTimeline } from "../utils/timebase";

/** One timeline flag for a clipping span of a clip. */
export type ClippingFlag = {
  id: string;
  trackId: string;
  /** Track name shown in the flag's label. */
  label: string;
  start: number;
  end: number;
};

/** Clipping flags for every clip, sorted by timeline start. */
export function clippingFlags(
  clipTracks: Record<string, ClipRow[]>,
  tracks: readonly Pick<TrackView, "id" | "label">[],
): ClippingFlag[] {
  const labels = new Map(tracks.map((t) => [t.id, t.label]));
  const flags: ClippingFlag[] = [];
  for (const [trackId, clips] of Object.entries(clipTracks)) {
    for (const clip of clips) {
      (clip.clipping_regions ?? []).forEach((region, i) => {
        const start = sourceSecInClipToTimeline(clip, region.start_s);
        const end = sourceSecInClipToTimeline(clip, region.end_s);
        if (start === null || end === null || end <= start) return;
        flags.push({
          id: `${clip.id}:${i}`,
          trackId,
          label: labels.get(trackId) ?? trackId,
          start,
          end,
        });
      });
    }
  }
  return flags.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
