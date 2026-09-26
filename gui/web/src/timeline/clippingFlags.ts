import type { ClipRow, TrackView } from "../types/project";

/**
 * Timeline second for source second `s` inside `clip`, or null when the clip
 * does not show that part of its source.
 */
export function sourceToTimelineSec(
  clip: Pick<
    ClipRow,
    "source_start" | "source_end" | "timeline_start" | "timeline_end"
  >,
  s: number,
): number | null {
  if (s < clip.source_start - 1e-9 || s > clip.source_end + 1e-9) {
    return null;
  }
  const t = clip.timeline_start + (s - clip.source_start);
  return Math.min(Math.max(t, clip.timeline_start), clip.timeline_end);
}

export type SourceTimelinePoint = {
  clip: ClipRow;
  trackId: string;
  timelineSec: number;
};

/** First clip of `sourceId` that shows source second `sec`. */
export function sourceToTimeline(
  clipTracks: Record<string, ClipRow[]>,
  sourceId: string,
  sec: number,
): SourceTimelinePoint | null {
  for (const [trackId, clips] of Object.entries(clipTracks)) {
    for (const clip of clips) {
      if (clip.source_id !== sourceId) continue;
      const timelineSec = sourceToTimelineSec(clip, sec);
      if (timelineSec !== null) return { clip, trackId, timelineSec };
    }
  }
  return null;
}

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
        const start = sourceToTimelineSec(clip, region.start_s);
        const end = sourceToTimelineSec(clip, region.end_s);
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
