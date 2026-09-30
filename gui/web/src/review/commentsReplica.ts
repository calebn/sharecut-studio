import { applyOrderedCommentRows } from "../document/projectionDelta";
import type { TimelineComment } from "../types/project";

export type CommentsReplica =
  | { kind: "awaiting" }
  | { kind: "ready"; revision: string; comments: TimelineComment[] };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid review comments");
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_000_000;
}
function nullableText(value: unknown): boolean {
  return value === null || text(value);
}
function comment(value: unknown): TimelineComment {
  const row = record(value);
  if (
    !text(row.id) ||
    !text(row.body) ||
    !text(row.author) ||
    !text(row.created_at) ||
    !nullableText(row.updated_at) ||
    typeof row.timeline_start !== "number" ||
    !Number.isFinite(row.timeline_start) ||
    !(
      row.timeline_end === null ||
      (typeof row.timeline_end === "number" &&
        Number.isFinite(row.timeline_end))
    ) ||
    !Array.isArray(row.track_ids) ||
    !row.track_ids.every(text) ||
    typeof row.resolved !== "boolean" ||
    !nullableText(row.resolved_at) ||
    !nullableText(row.resolved_by) ||
    !Array.isArray(row.replies) ||
    !row.replies.every((item: unknown) => {
      const reply = record(item);
      return (
        text(reply.id) &&
        text(reply.body) &&
        text(reply.author) &&
        text(reply.created_at)
      );
    }) ||
    !Array.isArray(row.action_items) ||
    !row.action_items.every((item: unknown) => {
      const action = record(item);
      return (
        text(action.id) &&
        text(action.text) &&
        typeof action.done === "boolean" &&
        nullableText(action.completed_at) &&
        nullableText(action.completed_by)
      );
    }) ||
    (row.review_version_id !== undefined &&
      !nullableText(row.review_version_id)) ||
    (row.edit_decision_id !== undefined && !nullableText(row.edit_decision_id))
  )
    throw new Error("Invalid review comment");
  return row as unknown as TimelineComment;
}
export function applyCommentsFrame(
  previous: CommentsReplica,
  raw: unknown,
): CommentsReplica {
  const frame = record(raw);
  if (frame.plane !== "comments") return previous;
  if (!text(frame.revision) || !/^[a-f0-9]{32}$/.test(frame.revision))
    throw new Error("Invalid comments revision");
  let values: unknown[];
  if (frame.type === "Snapshot") {
    if (!Array.isArray(frame.comments) || frame.comments.length > 200_000)
      throw new Error("Invalid comments snapshot");
    values = applyOrderedCommentRows([], {
      before_count: 0,
      splices: [{ index: 0, delete: 0, insert: frame.comments }],
      updates: [],
    });
  } else if (
    frame.type === "Applied" &&
    previous.kind === "ready" &&
    frame.previous_revision === previous.revision &&
    frame.revision !== previous.revision
  ) {
    values = applyOrderedCommentRows(previous.comments, frame.operations);
  } else throw new Error("Missing comments predecessor");
  return {
    kind: "ready",
    revision: frame.revision,
    comments: values.map(comment),
  };
}
