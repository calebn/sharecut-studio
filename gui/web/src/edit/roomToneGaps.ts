import { JOIN_GAP_TOLERANCE_SEC } from "../types/limits.generated";
import type {
  ExactRangeTarget,
  ProjectView,
  TimelineSpan,
} from "../types/project";

export type RoomToneGap = { track_id: string; interval: number };

/**
 * The time a room-tone fill would cover: for each selected track, the part of
 * each interval that lies between two clips and under none. Mirrors the
 * server's rule, so the action is offered only when it can do something.
 */
export function roomToneGaps(
  project: ProjectView,
  target: ExactRangeTarget,
  minGapSec = JOIN_GAP_TOLERANCE_SEC,
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
      target.intervals.forEach((span, interval) => {
        const start = Math.max(between.start, span.start);
        const end = Math.min(between.end, span.end);
        if (end - start > minGapSec) gaps.push({ track_id: trackId, interval });
      });
    }
  }
  return gaps;
}
