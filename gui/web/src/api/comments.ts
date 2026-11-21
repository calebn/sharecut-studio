import {
  mergeGuestActionDone,
  mergeReturnedComment,
  mergeReturnedReply,
} from "../document/applyDocumentUpdate";
import { commentFromCommandResult } from "../document/projectPatch";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { hostCauseNow } from "../state/hostReach";
import {
  appendOutbox,
  type OutboxAnchor,
  type OutboxRow,
  serverIdOf,
} from "../state/outboxStore";
import { DocumentCommand } from "../types/documentCommands.generated";
import type {
  CommentReply,
  HistoryEntryId,
  TimelineComment,
} from "../types/project";
import { withAbortTimeout } from "../utils/abortTimeout";
import { ApiError } from "../utils/apiError";
import { isKept, type KeptPost, newPostKey } from "../utils/keptPost";
import { replyHistoryHead, submitDocumentCommand } from "./documentEdits";
import { apiFetch, NETWORK_ERROR_CODE } from "./http";

export type GuestSendOutcome =
  | { status: "sent"; comment: TimelineComment | null }
  /** Nothing is settled: send it again later. `keep` is true when the host simply did not answer. */
  | { status: "retry"; error: unknown; keep: boolean }
  | { status: "refused"; code: number; error: ApiError };

const POST_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MESSAGE = "The host didn't answer.";
const KEEP_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 502, 503, 504,
]);

function classifyFailure(error: unknown): GuestSendOutcome {
  if (error instanceof ApiError) {
    const { status } = error;
    if (
      (status === null && error.code === NETWORK_ERROR_CODE) ||
      (status !== null && KEEP_STATUSES.has(status))
    ) {
      return { status: "retry", error, keep: true };
    }
    if (
      status !== null &&
      status >= 400 &&
      status < 500 &&
      !isDeadLink(error)
    ) {
      return { status: "refused", code: status, error };
    }
    return { status: "retry", error, keep: false };
  }
  const timedOut =
    error instanceof DOMException && error.name === "TimeoutError";
  // An answer that cannot be read may still have landed: sending it again is harmless.
  const unreadable = error instanceof SyntaxError;
  return {
    status: "retry",
    error,
    keep: timedOut || unreadable,
  };
}

function isDeadLink(error: ApiError): boolean {
  return error.status === 404 && error.code === "share_not_found";
}

function commentBody(row: OutboxRow): string {
  const anchor = row.anchor as OutboxAnchor;
  return JSON.stringify({
    comment_id: row.id,
    body: row.body,
    author: row.author,
    timeline_start: anchor.timeline_start,
    timeline_end: anchor.timeline_end,
    edit_decision_id: anchor.edit_decision_id,
    track_ids: anchor.track_ids,
    timeline_spans: anchor.timeline_spans,
  });
}

/**
 * One try at a guest's comment or reply. `replyTo` is the server's id for the
 * comment a reply answers. The row's own `id` rides along, so a repeat of a
 * send that landed returns what the first made.
 */
export async function sendGuestPost(
  token: string,
  row: OutboxRow,
  replyTo?: string,
): Promise<GuestSendOutcome> {
  const key = `share:${token}`;
  const json = { "Content-Type": "application/json" };
  try {
    if (row.kind === "comment") {
      const data = await withAbortTimeout(
        POST_TIMEOUT_MS,
        POST_TIMEOUT_MESSAGE,
        async (signal) => {
          const res = await apiFetch(
            key,
            { guest: "/comments" },
            { method: "POST", headers: json, body: commentBody(row), signal },
          );
          return (await res.json()) as { comment: TimelineComment };
        },
      );
      mergeReturnedComment(data.comment);
      return { status: "sent", comment: data.comment };
    }
    if (replyTo === undefined) {
      return {
        status: "retry",
        error: new Error("Comment not posted yet"),
        keep: true,
      };
    }
    const data = await withAbortTimeout(
      POST_TIMEOUT_MS,
      POST_TIMEOUT_MESSAGE,
      async (signal) => {
        const res = await apiFetch(
          key,
          { guest: `/comments/${encodeURIComponent(replyTo)}/replies` },
          {
            method: "POST",
            headers: json,
            body: JSON.stringify({
              reply_id: row.id,
              body: row.body,
              author: row.author,
            }),
            signal,
          },
        );
        return (await res.json()) as {
          comment_id: string;
          reply: CommentReply;
        };
      },
    );
    mergeReturnedReply(data.comment_id, data.reply);
    return { status: "sent", comment: null };
  } catch (error) {
    return classifyFailure(error);
  }
}

/**
 * Sends a guest post now, or keeps it in the outbox when the host did not
 * answer. Anything else the host said throws, with the text still in the field.
 */
async function sendOrKeep(
  token: string,
  row: OutboxRow,
  replyTo?: string,
): Promise<TimelineComment | KeptPost | null> {
  const away = hostCauseNow(token);
  if (away !== null && (await appendOutbox(token, row))) {
    return { kept: true, id: row.id };
  }
  const outcome = await sendGuestPost(token, row, replyTo);
  if (outcome.status === "sent") return outcome.comment;
  if (
    outcome.status === "retry" &&
    outcome.keep &&
    (await appendOutbox(token, row))
  ) {
    return { kept: true, id: row.id };
  }
  throw outcome.error;
}

export async function createComment(
  projectPath: string,
  opts: {
    body: string;
    author: string;
    timelineStart: number;
    timelineEnd?: number | null;
    trackIds?: string[];
    timelineSpans?: { start: number; end: number }[];
    actionTexts?: string[];
    editDecisionId?: string | null;
    /** A guest's key for this comment; a retry of the same text passes the same one. */
    postKey?: string;
  },
): Promise<TimelineComment | KeptPost | null> {
  const token = shareTokenFromKey(projectPath);
  if (token) {
    return sendOrKeep(token, {
      id: opts.postKey ?? newPostKey(),
      kind: "comment",
      body: opts.body,
      author: opts.author,
      created_at: Date.now(),
      anchor: {
        timeline_start: opts.timelineStart,
        timeline_end: opts.timelineEnd ?? null,
        timeline_spans: opts.timelineSpans ?? null,
        track_ids: opts.trackIds ?? [],
        edit_decision_id: opts.editDecisionId ?? null,
      },
    });
  }
  const data = await submitDocumentCommand(
    projectPath,
    DocumentCommand.AddComment,
    {
      body: opts.body,
      author: opts.author,
      timeline_start: opts.timelineStart,
      timeline_end: opts.timelineEnd ?? null,
      track_ids: opts.trackIds ?? [],
      timeline_spans: opts.timelineSpans ?? null,
      action_texts: opts.actionTexts ?? [],
      edit_decision_id: opts.editDecisionId ?? null,
    },
  );
  if (data.queued === true) {
    return null;
  }
  const comment = commentFromCommandResult(data);
  if (!comment) {
    throw new Error("AddComment did not return a comment");
  }
  return comment;
}

export async function patchComment(
  projectPath: string,
  commentId: string,
  opts: {
    body?: string;
    resolved?: boolean;
    by?: string;
  },
): Promise<TimelineComment | null> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Resolving comments is not available for shared guests");
  }
  const type =
    opts.resolved != null
      ? DocumentCommand.ResolveComment
      : DocumentCommand.UpdateComment;
  const data = await submitDocumentCommand(projectPath, type, {
    comment_id: commentId,
    ...(opts.body != null ? { body: opts.body } : {}),
    ...(opts.resolved != null ? { resolved: opts.resolved } : {}),
    ...(opts.by != null ? { by: opts.by } : {}),
  });
  if (data.queued === true) {
    return null;
  }
  const comment = commentFromCommandResult(data);
  if (!comment) {
    throw new Error(`${type} did not return a comment`);
  }
  return comment;
}

export async function deleteComment(
  projectPath: string,
  commentId: string,
): Promise<HistoryEntryId | null> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Removing comments is not available for shared guests");
  }
  const reply = await submitDocumentCommand(
    projectPath,
    DocumentCommand.DeleteComment,
    { comment_id: commentId },
  );
  return reply ? replyHistoryHead(reply) : null;
}

export async function setCommentActionDone(
  projectPath: string,
  commentId: string,
  actionId: string,
  opts: { done: boolean; by: string },
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    await apiFetch(
      projectPath,
      {
        guest: `/comments/${encodeURIComponent(commentId)}/actions/${encodeURIComponent(actionId)}/done`,
      },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          done: opts.done,
          by: opts.by,
        }),
      },
    );
    mergeGuestActionDone(commentId, actionId, opts.done);
    return;
  }
  await submitDocumentCommand(projectPath, DocumentCommand.SetActionDone, {
    comment_id: commentId,
    action_id: actionId,
    done: opts.done,
    by: opts.by,
  });
}

export async function addCommentReply(
  projectPath: string,
  commentId: string,
  opts: { body: string; author: string; postKey?: string },
): Promise<KeptPost | undefined> {
  const token = shareTokenFromKey(projectPath);
  if (token) {
    const comments = useDawStore.getState().project?.comments ?? [];
    const target = serverIdOf(commentId, comments);
    const kept = await sendOrKeep(
      token,
      {
        id: opts.postKey ?? newPostKey(),
        kind: "reply",
        body: opts.body,
        author: opts.author,
        created_at: Date.now(),
        parent_comment_id: commentId,
      },
      target ?? undefined,
    );
    return isKept(kept) ? kept : undefined;
  }
  await submitDocumentCommand(projectPath, DocumentCommand.AddReply, {
    comment_id: commentId,
    body: opts.body,
    author: opts.author,
  });
}
