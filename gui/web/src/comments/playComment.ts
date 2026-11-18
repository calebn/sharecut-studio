import { playSpan } from "../commands/playSpan";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";

const PAD_SEC = 2;

export function playComment(c: TimelineComment): void {
  const s = useDawStore.getState();
  s.setSelection({ kind: "comment", id: c.id });
  const r = playSpan(
    c.timeline_start,
    c.timeline_end ?? c.timeline_start,
    PAD_SEC,
  );
  if (r.status === "disabled") {
    s.announceStatus(r.reason, { tone: "error" });
    return;
  }
  // beginAudition does not break follow, so break it once playback starts.
  s.stopFollow("local");
}
