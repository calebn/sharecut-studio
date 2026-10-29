import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { playTimelineRange } from "../utils/playRange";

const PAD_SEC = 2;

/** Selects the comment and plays its time range with a little room either side. */
export function playComment(c: TimelineComment): void {
  const s = useDawStore.getState();
  s.setSelection({ kind: "comment", id: c.id });
  playTimelineRange({
    start: c.timeline_start,
    end: c.timeline_end ?? c.timeline_start,
    padSec: PAD_SEC,
    beginAudition: s.beginAudition,
    setPlayheadSec: s.setPlayheadSec,
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
  });
}
