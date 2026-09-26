import type { ClipRow } from "../types/project";

const EPS = 1e-9;

/**
 * Map a timeline second to source media time via clip dual clocks.
 * Mirrors ``clip_timeline_point_to_source`` / SessionTimeline.timeline_to_source.
 */
export function timelinePointToSource(
  clips: ClipRow[],
  timelineSec: number,
): number | null {
  // Half-open [timeline_start, timeline_end) so joins land on the next clip.
  for (const clip of clips) {
    if (
      timelineSec + EPS >= clip.timeline_start &&
      timelineSec + EPS < clip.timeline_end
    ) {
      return clip.source_start + (timelineSec - clip.timeline_start);
    }
  }
  return null;
}

/**
 * Map a source media second to timeline time via clip dual clocks.
 * Mirrors SessionTimeline.source_to_timeline (first covering clip).
 */
export function sourcePointToTimeline(
  clips: ClipRow[],
  sourceSec: number,
): number | null {
  let best: number | null = null;
  for (const clip of clips) {
    if (
      sourceSec + EPS >= clip.source_start &&
      sourceSec + EPS < clip.source_end
    ) {
      const tl = clip.timeline_start + (sourceSec - clip.source_start);
      if (best === null || tl < best) {
        best = tl;
      }
    }
  }
  return best;
}

export function clipsForTrack(
  clipsByTrack: Record<string, ClipRow[]> | undefined,
  trackId: string,
): ClipRow[] {
  return clipsByTrack?.[trackId] ?? [];
}

export function originTrackId(clip: ClipRow): string {
  return clip.origin_track_id ?? clip.track_id;
}

/** Clips whose audio originates on this track (pinned source or current lane). */
export function clipsForOriginTrack(
  clipsByTrack: Record<string, ClipRow[]> | undefined,
  trackId: string,
): ClipRow[] {
  if (!clipsByTrack) {
    return [];
  }
  const out: ClipRow[] = [];
  for (const list of Object.values(clipsByTrack)) {
    for (const clip of list) {
      if (originTrackId(clip) === trackId) {
        out.push(clip);
      }
    }
  }
  return out;
}

/** Map a source second on one clip to timeline (no half-open / null). */
export function sourceSecOnClipToTimeline(
  clip: Pick<ClipRow, "source_start" | "timeline_start">,
  sourceSec: number,
): number {
  return clip.timeline_start + (sourceSec - clip.source_start);
}

/**
 * Timeline second for source second `sourceSec` inside `clip`, or null when
 * the clip does not show it. Unlike `sourcePointToTimeline`, both ends are
 * inclusive (a span may end on the clip's out point) and the result is clamped
 * to the clip.
 */
export function sourceSecInClipToTimeline(
  clip: Pick<
    ClipRow,
    "source_start" | "source_end" | "timeline_start" | "timeline_end"
  >,
  sourceSec: number,
): number | null {
  if (
    sourceSec < clip.source_start - EPS ||
    sourceSec > clip.source_end + EPS
  ) {
    return null;
  }
  const t = sourceSecOnClipToTimeline(clip, sourceSec);
  return Math.min(Math.max(t, clip.timeline_start), clip.timeline_end);
}

export type SourceTimelinePoint = {
  clip: ClipRow;
  trackId: string;
  timelineSec: number;
};

/** First clip (any track) of `sourceId` that shows source second `sourceSec`. */
export function sourceIdPointToTimeline(
  clipTracks: Record<string, ClipRow[]>,
  sourceId: string,
  sourceSec: number,
): SourceTimelinePoint | null {
  for (const [trackId, clips] of Object.entries(clipTracks)) {
    for (const clip of clips) {
      if (clip.source_id !== sourceId) continue;
      const timelineSec = sourceSecInClipToTimeline(clip, sourceSec);
      if (timelineSec !== null) return { clip, trackId, timelineSec };
    }
  }
  return null;
}
