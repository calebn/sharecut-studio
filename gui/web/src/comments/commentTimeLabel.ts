import type { TimelineComment } from "../types/project";
import { commentAnchorLabel } from "./commentAnchor";

export function commentTimeLabel(c: TimelineComment): string {
  return commentAnchorLabel({
    startSec: c.timeline_start,
    endSec: c.timeline_end,
  });
}
