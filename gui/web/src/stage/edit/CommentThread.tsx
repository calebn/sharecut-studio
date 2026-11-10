import { useState } from "react";
import { seekTransport } from "../../commands/seek";
import { useCommentActions } from "../../comments";
import { canReply, canSetAction, commentRole } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { CommentCard } from "../../system/CommentCard";
import { InlineError } from "../../ui";
import { commentCardOf } from "../hosts/commentCardData";

/**
 * The thread of one selected comment on the shared comment card. Resolve
 * belongs to the Action bar, so the card offers only Reopen, and only to the
 * host. A share link sees Reply when its link allows replies and never Reopen.
 */
export function CommentThread({ commentId }: { commentId: string }) {
  const { project, guestMode, shareCapabilities, projectPath } = useDaw(
    (s) => ({
      project: s.project,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      projectPath: s.projectPath,
    }),
  );
  const role = commentRole(projectPath, guestMode);
  const [replyBody, setReplyBody] = useState("");
  const { busy, error, resolve, reply, toggleAction } = useCommentActions({
    role,
  });
  const comment = project?.comments?.find((c) => c.id === commentId);
  if (!comment) return <p className="ui-field-hint">Comment not found</p>;
  const mayReply = canReply(projectPath, guestMode, shareCapabilities);
  const mayToggle = canSetAction(projectPath, shareCapabilities);
  return (
    <div className="comment-thread">
      <CommentCard
        comment={commentCardOf(
          comment,
          comment.resolved,
          project?.timeline_duration_sec ?? Number.NaN,
        )}
        onSelect={() => void seekTransport(comment.timeline_start)}
        onResolve={
          role === "host" && comment.resolved
            ? () => void resolve(comment, false)
            : undefined
        }
        onToggleAction={
          mayToggle
            ? (actionId, done) => void toggleAction(comment, actionId, done)
            : undefined
        }
        reply={
          mayReply
            ? {
                body: replyBody,
                onBodyChange: setReplyBody,
                onSubmit: () =>
                  void reply(comment, replyBody).then((ok) => {
                    if (ok) setReplyBody("");
                  }),
                state: busy ? "posting" : "idle",
              }
            : undefined
        }
      />
      <InlineError message={error} />
    </div>
  );
}
