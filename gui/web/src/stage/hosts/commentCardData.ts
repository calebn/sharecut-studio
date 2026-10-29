import type { CommentCardData } from "../../system/CommentCard";
import type { TimelineComment } from "../../types/project";

const EPISODE_SLACK_SEC = 0.01;

/** A whole-episode note is stored as the full span, so it shows no time. */
function isEpisodeNote(c: TimelineComment, durationSec: number): boolean {
  return (
    c.timeline_start <= 0 &&
    c.timeline_end != null &&
    Number.isFinite(durationSec) &&
    c.timeline_end >= durationSec - EPISODE_SLACK_SEC
  );
}

export function commentCardOf(
  c: TimelineComment,
  resolved: boolean,
  durationSec: number,
): CommentCardData {
  return {
    id: c.id,
    author: c.author,
    at: isEpisodeNote(c, durationSec)
      ? undefined
      : { start: c.timeline_start, end: c.timeline_end ?? undefined },
    body: c.body,
    resolved,
    resolvedBy: c.resolved_by ?? undefined,
    replies: c.replies.map(({ id, author, body }) => ({ id, author, body })),
    actions: c.action_items.map((a) => ({
      id: a.id,
      text: a.text,
      done: a.done,
      doneBy: a.completed_by ?? undefined,
    })),
  };
}
