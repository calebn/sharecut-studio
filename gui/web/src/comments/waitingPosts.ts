import {
  type OutboxRow,
  type OutboxView,
  serverIdOf,
  slotOf,
  waitingSlot,
} from "../state/outboxStore";
import type { TimelineComment } from "../types/project";

type WaitingState = "waiting" | "sending";

export type WaitingReply = { row: OutboxRow; state: WaitingState };

type CommentsWithWaiting = {
  comments: TimelineComment[];
  waiting: ReadonlyMap<string, { row: OutboxRow; state: WaitingState }>;
  waitingReplies: ReadonlyMap<string, readonly WaitingReply[]>;
  serverId: (slot: string) => string | null;
};

const stateOf = (view: OutboxView, id: string): WaitingState =>
  view.sending.has(id) ? "sending" : "waiting";

function keptComment(row: OutboxRow): TimelineComment {
  const anchor = row.anchor;
  return {
    id: waitingSlot(row.id),
    body: row.body,
    author: row.author,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: null,
    timeline_start: anchor?.timeline_start ?? 0,
    timeline_end: anchor?.timeline_end ?? null,
    ...(anchor?.timeline_spans
      ? { timeline_spans: anchor.timeline_spans }
      : {}),
    track_ids: anchor?.track_ids ?? [],
    action_items: [],
    replies: [],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
    edit_decision_id: anchor?.edit_decision_id ?? null,
  };
}

/** A guest comment keeps one id (`slotOf`) from kept to landed, so its card stays the same element. */
export function withWaitingPosts(
  projectComments: readonly TimelineComment[],
  view: OutboxView,
): CommentsWithWaiting {
  const landed = projectComments.map((c) => ({
    ...c,
    id: slotOf(c.id),
    replies: c.replies.map((r) => ({ ...r, id: slotOf(r.id) })),
  }));
  const slots = new Set(landed.map((c) => c.id));
  const waiting = new Map<string, { row: OutboxRow; state: WaitingState }>();
  const kept: TimelineComment[] = [];
  const waitingReplies = new Map<string, WaitingReply[]>();
  for (const row of view.rows) {
    if (row.kind === "comment") {
      const slot = waitingSlot(row.id);
      if (slots.has(slot)) continue;
      waiting.set(slot, { row, state: stateOf(view, row.id) });
      kept.push(keptComment(row));
      continue;
    }
    const parent = row.parent_comment_id ? slotOf(row.parent_comment_id) : "";
    const answered = landed
      .find((c) => c.id === parent)
      ?.replies.some((r) => r.id === waitingSlot(row.id));
    if (answered) continue;
    waitingReplies.set(parent, [
      ...(waitingReplies.get(parent) ?? []),
      { row, state: stateOf(view, row.id) },
    ]);
  }
  const comments = [...landed, ...kept].sort(
    (a, b) =>
      a.timeline_start - b.timeline_start ||
      (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0),
  );
  return {
    comments,
    waiting,
    waitingReplies,
    serverId: (slot) => serverIdOf(slot, projectComments),
  };
}
