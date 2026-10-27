import type { SaveIndicatorProps } from "../../system/SaveIndicator";

export type CommentStatus = "queued" | "sending" | "sent" | "failed";

export type QueuedComment = {
  id: string;
  body: string;
  /** Seconds into the episode the comment is anchored at. */
  at: number;
  name: string;
  status: CommentStatus;
};

export type QueueEvent =
  | { type: "post"; comment: Omit<QueuedComment, "status"> }
  | { type: "sendStarted"; id: string }
  | { type: "sent"; id: string }
  | { type: "failed"; id: string }
  | { type: "retry"; id: string };

const FROM: Record<Exclude<QueueEvent["type"], "post">, CommentStatus> = {
  sendStarted: "queued",
  sent: "sending",
  failed: "sending",
  retry: "failed",
};
const TO: Record<Exclude<QueueEvent["type"], "post">, CommentStatus> = {
  sendStarted: "sending",
  sent: "sent",
  failed: "failed",
  retry: "queued",
};

/** Every comment waits as `queued` until sent, so online and offline posts take one path. An event that does not fit the comment's status is ignored. */
export function queueReducer(
  queue: readonly QueuedComment[],
  event: QueueEvent,
): readonly QueuedComment[] {
  if (event.type === "post") {
    return [...queue, { ...event.comment, status: "queued" }];
  }
  return queue.map((comment) =>
    comment.id === event.id && comment.status === FROM[event.type]
      ? { ...comment, status: TO[event.type] }
      : comment,
  );
}

/** The comment to send now: the oldest queued one, only online and only when none is in flight, so they arrive in order. */
export function dueToSend(
  queue: readonly QueuedComment[],
  online: boolean,
): string | null {
  if (!online || queue.some((comment) => comment.status === "sending")) {
    return null;
  }
  return queue.find((comment) => comment.status === "queued")?.id ?? null;
}

/** The small glyph after a posted comment: a clock until it is sent, an alert when it was refused. */
export function glyphOf(status: CommentStatus): "clock" | "alert" | null {
  if (status === "queued" || status === "sending") return "clock";
  return status === "failed" ? "alert" : null;
}

export const waitingCount = (queue: readonly QueuedComment[]) =>
  queue.filter((c) => c.status === "queued" || c.status === "sending").length;

/** What the Save indicator shows: the hollow cloud with a count offline, saving while the queue drains. */
export function saveOf(
  queue: readonly QueuedComment[],
  online: boolean,
): SaveIndicatorProps {
  const waiting = waitingCount(queue);
  if (!online) return { state: "offline", waiting };
  if (queue.some((c) => c.status === "failed")) return { state: "failed" };
  return waiting > 0 ? { state: "saving" } : { state: "saved" };
}
