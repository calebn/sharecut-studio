import type { SessionTarget } from "../record";
import type { ProjectView } from "../types/project";
import type { EditSpan } from "./editSelection";

// The server refuses a replace that ends past the timeline by more than this.
const TIMELINE_EPSILON = 1e-3;

function lastClipEnd(project: ProjectView): number {
  let end = 0;
  for (const clips of Object.values(project.clips.tracks)) {
    for (const clip of clips) end = Math.max(end, clip.timeline_end);
  }
  return end;
}

/**
 * The selection as a span a Record take can replace: it covers time on at
 * least one track and ends inside the timeline. Null otherwise, which is when
 * Re-record and the target chip's Replace selection are absent.
 */
export function replaceableSpan(
  span: EditSpan | null,
  project: ProjectView | null,
): EditSpan | null {
  if (!span || !project) return null;
  const timelineEnd =
    project.clips.timeline_duration_sec ?? lastClipEnd(project);
  return span.end > span.start &&
    span.trackIds.length > 0 &&
    span.end <= timelineEnd + TIMELINE_EPSILON
    ? span
    : null;
}

/** Replace the selected span: the target Re-record asks Record to open with. */
export function replaceTargetOf(span: EditSpan): SessionTarget {
  return {
    kind: "replace",
    from_sec: span.start,
    to_sec: span.end,
    track_ids: [...span.trackIds],
  };
}
