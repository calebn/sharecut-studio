import {
  mergeGuestActionDone,
  mergeReturnedComment,
} from "../document/applyDocumentUpdate";
import { commentFromCommandResult } from "../document/projectPatch";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import type { TimelineComment } from "../types/project";
import { submitDocumentCommand } from "./documentEdits";

export async function createComment(
  projectPath: string,
  opts: {
    body: string;
    author: string;
    timelineStart: number;
    timelineEnd?: number | null;
    trackIds?: string[];
    actionTexts?: string[];
    editDecisionId?: string | null;
  },
): Promise<TimelineComment | null> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(`${reviewApiBase(token)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: opts.body,
        author: opts.author,
        timeline_start: opts.timelineStart,
        timeline_end: opts.timelineEnd ?? null,
        edit_decision_id: opts.editDecisionId ?? null,
        track_ids: opts.trackIds ?? [],
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = (await res.json()) as { comment: TimelineComment };
    mergeReturnedComment(data.comment);
    return data.comment;
  }
  const data = await submitDocumentCommand(projectPath, "AddComment", {
    body: opts.body,
    author: opts.author,
    timeline_start: opts.timelineStart,
    timeline_end: opts.timelineEnd ?? null,
    track_ids: opts.trackIds ?? [],
    action_texts: opts.actionTexts ?? [],
    edit_decision_id: opts.editDecisionId ?? null,
  });
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
  const type = opts.resolved != null ? "ResolveComment" : "UpdateComment";
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

export async function setCommentActionDone(
  projectPath: string,
  commentId: string,
  actionId: string,
  opts: { done: boolean; by: string },
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/comments/${encodeURIComponent(commentId)}/actions/${encodeURIComponent(actionId)}/done`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          done: opts.done,
          by: opts.by,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    mergeGuestActionDone(commentId, actionId, opts.done);
    return;
  }
  await submitDocumentCommand(projectPath, "SetActionDone", {
    comment_id: commentId,
    action_id: actionId,
    done: opts.done,
    by: opts.by,
  });
}

export async function addCommentReply(
  projectPath: string,
  commentId: string,
  opts: { body: string; author: string },
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/comments/${encodeURIComponent(commentId)}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: opts.body,
          author: opts.author,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return;
  }
  await submitDocumentCommand(projectPath, "AddReply", {
    comment_id: commentId,
    body: opts.body,
    author: opts.author,
  });
}
