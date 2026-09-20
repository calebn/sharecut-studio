import type { TimelineComment } from "../types/project";
import { formatTimeShort } from "../utils/time";

export function commentTimeLabel(c: TimelineComment): string {
  const start = formatTimeShort(c.timeline_start);
  if (c.timeline_end != null && c.timeline_end > c.timeline_start) {
    return `${start}–${formatTimeShort(c.timeline_end)}`;
  }
  return start;
}
