import { useState } from "react";
import { commentTimeLabel, useCommentActions } from "../../comments";
import { canReply, canSetAction } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { TimelineComment } from "../../types/project";
import { Button, DefItem, DefinitionList } from "../../ui";
import { ModifierInspector } from "../ModifierInspector";

interface Props {
  comment: TimelineComment;
  onSeek: (sec: number) => void;
}

export function CommentInspector({ comment, onSeek }: Props) {
  const { guestMode, shareCapabilities, projectPath } = useDaw((s) => ({
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    projectPath: s.projectPath,
  }));
  const guestShare = guestMode != null;
  const mayReply = canReply(projectPath, guestMode, shareCapabilities);
  const mayAction = canSetAction(projectPath, shareCapabilities);
  const [replyBody, setReplyBody] = useState("");
  const { busy, error, resolve, reply, toggleAction } = useCommentActions();

  const timeLabel = commentTimeLabel(comment);

  return (
    <ModifierInspector
      badge="Comment"
      title="Comment"
      subtitle={timeLabel}
      primaryActions={
        guestShare
          ? undefined
          : [
              {
                label: comment.resolved ? "Reopen" : "Resolve",
                variant: "primary",
                disabled: busy,
                onClick: () => void resolve(comment, !comment.resolved),
              },
            ]
      }
      error={error}
    >
      <DefinitionList>
        <DefItem label="Time">
          <Button onClick={() => onSeek(comment.timeline_start)}>
            {timeLabel}
          </Button>
        </DefItem>
        <DefItem label="Author">{comment.author}</DefItem>
        <DefItem label="Status">
          {comment.resolved
            ? `Resolved${comment.resolved_by ? ` by ${comment.resolved_by}` : ""}`
            : "Open"}
        </DefItem>
        {comment.track_ids.length > 0 ? (
          <DefItem label="Tracks">{comment.track_ids.join(", ")}</DefItem>
        ) : null}
      </DefinitionList>
      <p className="inspector-body">{comment.body}</p>
      {comment.action_items.length > 0 ? (
        <>
          <h3>Action items</h3>
          <ul className="inspector-actions interactive">
            {comment.action_items.map((a) => (
              <li key={a.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={a.done}
                    disabled={busy || !mayAction}
                    onChange={(e) =>
                      void toggleAction(comment, a.id, e.target.checked)
                    }
                  />
                  <span className={a.done ? "done" : ""}>{a.text}</span>
                  {a.done && a.completed_by ? (
                    <span className="comment-meta"> ({a.completed_by})</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {(comment.replies ?? []).length > 0 ? (
        <>
          <h3>Replies</h3>
          <ul className="comment-replies">
            {(comment.replies ?? []).map((r) => (
              <li key={r.id}>
                <span className="comment-card-author">{r.author}</span>
                <span className="comment-card-body">{r.body}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {mayReply ? (
        <div className="comment-reply-compose">
          <input
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Reply…"
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void reply(comment, replyBody).then((ok) => {
                if (ok) {
                  setReplyBody("");
                }
              })
            }
          >
            Reply
          </button>
        </div>
      ) : null}
    </ModifierInspector>
  );
}
