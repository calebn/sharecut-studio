import type { ReactNode } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import type { TimelineComment } from "../types/project";
import { Button } from "../ui";
import { commentTimeLabel } from "./commentTimeLabel";

type Props = {
  comment: TimelineComment;
  selected?: boolean;
  busy?: boolean;
  guestShare?: boolean;
  replyDraft?: string;
  onReplyDraftChange?: (value: string) => void;
  onSelect?: () => void;
  onReply?: () => void;
  onResolve?: (resolved: boolean) => void;
  onToggleAction?: (actionId: string, done: boolean) => void;
  /** When false, omit resolve/reopen footer (review read views). */
  showResolve?: boolean;
  /** When false, omit reply compose. */
  showReply?: boolean;
  /** When false, omit interactive action checkboxes. */
  showActions?: boolean;
  children?: ReactNode;
};

export function CommentCard({
  comment: c,
  selected = false,
  busy = false,
  guestShare = false,
  replyDraft = "",
  onReplyDraftChange,
  onSelect,
  onReply,
  onResolve,
  onToggleAction,
  showResolve = true,
  showReply = true,
  showActions = true,
  children,
}: Props) {
  const className = `comment-card${selected ? " selected" : ""}${
    c.resolved ? " resolved" : ""
  }`;

  const main = (
    <>
      <span className="comment-card-time">{commentTimeLabel(c)}</span>
      <span className="comment-card-author">{c.author}</span>
      <span className="comment-card-body">{c.body}</span>
      {c.track_ids.length > 0 ? (
        <span className="comment-card-tracks">{c.track_ids.join(", ")}</span>
      ) : null}
    </>
  );

  return (
    <li
      className={className}
      {...presenceAnchorProps(presenceAnchor("comment", c.id))}
    >
      {onSelect ? (
        <button type="button" className="comment-card-main" onClick={onSelect}>
          {main}
        </button>
      ) : (
        <div className="comment-card-main static">{main}</div>
      )}
      {showActions && c.action_items.length > 0 ? (
        <ul className="comment-actions">
          {c.action_items.map((a) => (
            <li key={a.id}>
              <label>
                <input
                  type="checkbox"
                  checked={a.done}
                  disabled={busy || !onToggleAction}
                  onChange={(e) => onToggleAction?.(a.id, e.target.checked)}
                />
                <span className={a.done ? "done" : ""}>{a.text}</span>
                {a.done && a.completed_by ? (
                  <span className="comment-meta"> ({a.completed_by})</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {(c.replies ?? []).length > 0 ? (
        <ul className="comment-replies">
          {(c.replies ?? []).map((r) => (
            <li key={r.id}>
              <span className="comment-card-author">{r.author}</span>
              <span className="comment-card-body">{r.body}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {showReply && onReply && onReplyDraftChange ? (
        <div className="comment-reply-compose">
          <input
            value={replyDraft}
            onChange={(e) => onReplyDraftChange(e.target.value)}
            placeholder="Reply…"
            disabled={busy}
          />
          <Button disabled={busy} onClick={() => onReply()}>
            Reply
          </Button>
        </div>
      ) : null}
      {showResolve && !guestShare && onResolve ? (
        <div className="comment-card-footer">
          {c.resolved ? (
            <Button disabled={busy} onClick={() => onResolve(false)}>
              Reopen
              {c.resolved_by ? ` (was ${c.resolved_by})` : ""}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => onResolve(true)}>
              Resolve
            </Button>
          )}
        </div>
      ) : null}
      {children}
    </li>
  );
}
