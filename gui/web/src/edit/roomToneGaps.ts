import type {
  ExactRangeTarget,
  ProjectView,
  TimelineSpan,
} from "../types/project";

export type RoomToneGap = { track_id: string; start: number; end: number };

/**
 * The time a room-tone fill would cover: for each selected track, the part of
 * each interval that lies between two clips and under none. Mirrors the
 * server's rule, so the action is offered only when it can do something.
 */
export function roomToneGaps(
  project: ProjectView,
  target: ExactRangeTarget,
  minGapSec = 0.05,
): RoomToneGap[] {
  const gaps: RoomToneGap[] = [];
  for (const trackId of target.track_ids) {
    const clips = [...(project.clips.tracks[trackId] ?? [])].sort(
      (a, b) => a.timeline_start - b.timeline_start,
    );
    let covered = 0;
    for (let i = 0; i + 1 < clips.length; i++) {
      covered = Math.max(covered, clips[i]!.timeline_end);
      const between: TimelineSpan = {
        start: covered,
        end: clips[i + 1]!.timeline_start,
      };
      for (const interval of target.intervals) {
        const start = Math.max(between.start, interval.start);
        const end = Math.min(between.end, interval.end);
        if (end - start > minGapSec)
          gaps.push({ track_id: trackId, start, end });
      }
    }
  }
  return gaps;
}
