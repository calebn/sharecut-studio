import { playSpan } from "../commands/playSpan";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";

const PAD_SEC = 2;

export function playComment(c: TimelineComment): void {
  const s = useDawStore.getState();
  s.setSelection({ kind: "comment", id: c.id });
  // beginAudition does not break follow, so break it here.
  s.stopFollow("local");
  const r = playSpan(
    c.timeline_start,
    c.timeline_end ?? c.timeline_start,
    PAD_SEC,
  );
  if (r.status === "disabled") s.announceStatus(r.reason, { tone: "error" });
}
