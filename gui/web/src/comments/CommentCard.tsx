import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { useSwipeLeft } from "../hooks/useSwipeLeft";
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
  /**
   * Opt in to touch swipe-left → Resolve (comment lists only). Off by default
   * so embedded threads (e.g. the pending-edit Ask thread) never resolve from
   * a stray horizontal drag.
   */
  swipeToResolve?: boolean;
  children?: ReactNode;
};

/** Controls inside the card keep their own touch behavior. */
const GESTURE_EXEMPT_SELECTOR =
  "button,input,textarea,label,select,a,[contenteditable],.comment-replies";

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
  swipeToResolve = false,
  children,
}: Props) {
  const canResolve = showResolve && !guestShare && onResolve;
  const swipe = useSwipeLeft(
    Boolean(swipeToResolve && canResolve && !busy && !c.resolved),
    () => onResolve?.(true),
  );
  const longPress = useLongPress(() => {
    swipe.reset();
    onSelect?.();
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>) => {
    const target = event.target as Element;
    if (
      target.closest(GESTURE_EXEMPT_SELECTOR) &&
      !target.closest(".comment-card-main")
    ) {
      swipe.reset();
      return;
    }
    if (onSelect) longPress.onPointerDown(event);
    swipe.onPointerDown(event);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
    longPress.onPointerMove(event);
    swipe.onPointerMove(event);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLLIElement>) => {
    longPress.onPointerUp(event);
    swipe.onPointerUp(event);
  };
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
      onPointerDown={onPointerDown}
      onClickCapture={longPress.onClickCapture}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
      onPointerCancel={(event) => {
        longPress.onPointerCancel(event);
        swipe.onPointerCancel(event);
      }}
      {...presenceAnchorProps(presenceAnchor("comment", c.id))}
    >
      {onSelect ? (
        <button
          type="button"
          className="comment-card-main"
          onClick={() => {
            if (swipe.justSwiped()) return;
            onSelect();
          }}
        >
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
      {canResolve ? (
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
