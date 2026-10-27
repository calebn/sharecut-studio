import { Avatar, Button } from "../ui";
import { Composer, type ComposerProps } from "./Composer";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { formatSeconds } from "./seconds";
import { iconOf, verbOf } from "./verbDisplay";

export type CommentCardData = {
  id: string;
  author: string;
  seconds: number;
  body: string;
  resolved: boolean;
  resolvedBy?: string;
  replies: { id: string; author: string; body: string }[];
  actions: { id: string; text: string; done: boolean; doneBy?: string }[];
  /** Waiting in the offline queue, or refused by the server. */
  pending?: "queued" | "failed";
};

export type CommentCardProps = {
  comment: CommentCardData;
  selected?: boolean;
  /** A guest viewer or commenter: no resolve, no action toggles. */
  readOnly?: boolean;
  /** Jump the playhead to the comment's time. */
  onSelect?: () => void;
  /** The caller owns the Undo toast. */
  onResolve?: (resolved: boolean) => void;
  onToggleAction?: (id: string, done: boolean) => void;
  /** Replying reuses the Composer. */
  reply?: ComposerProps;
};

const RESOLVE = verbOf("resolve");
const PENDING_TEXT = {
  queued: "Waiting to send",
  failed: "Not sent",
} as const;

const repliesText = (count: number) =>
  count === 1 ? "1 reply" : `${count} replies`;

/** A comment with its replies and action items, restyled on the Review queue row. */
export function CommentCard({
  comment: c,
  selected = false,
  readOnly = false,
  onSelect,
  onResolve,
  onToggleAction,
  reply,
}: CommentCardProps) {
  const settled = c.pending === undefined;
  const canResolve = !readOnly && settled && onResolve !== undefined;
  const canToggle = !readOnly && settled && onToggleAction !== undefined;
  const head = (
    <>
      <Avatar name={c.author} size="sm" />
      <span className="sys-comment-text">
        <span className="sys-comment-by">
          <span className="sys-comment-author">{c.author}</span>
          <span className="sys-mono sys-comment-time">
            {formatSeconds(c.seconds)}
          </span>
          {c.pending ? (
            <span className="sys-comment-pending sys-tone-warning">
              <StatusGlyph
                state={c.pending === "queued" ? "offline" : "failed"}
                size={14}
                text={false}
              />
              {PENDING_TEXT[c.pending]}
            </span>
          ) : null}
        </span>
        <span className="sys-comment-body">{c.body}</span>
      </span>
    </>
  );
  return (
    <div
      className="sys-comment"
      data-selected={selected || undefined}
      data-resolved={c.resolved || undefined}
      data-pending={c.pending}
    >
      {onSelect ? (
        <button
          type="button"
          className="sys-comment-main"
          aria-current={selected ? "true" : undefined}
          aria-label={`${c.author}, ${formatSeconds(c.seconds)}: ${c.body}`}
          onClick={onSelect}
        >
          {head}
        </button>
      ) : (
        <div className="sys-comment-main sys-comment-main--static">{head}</div>
      )}
      {c.actions.length > 0 ? (
        <ul className="sys-comment-actions" aria-label="Action items">
          {c.actions.map((a) => (
            <li key={a.id}>
              <label className="sys-comment-action">
                <input
                  type="checkbox"
                  checked={a.done}
                  disabled={!canToggle}
                  onChange={(event) =>
                    onToggleAction?.(a.id, event.target.checked)
                  }
                />
                <span data-done={a.done || undefined}>{a.text}</span>
                {a.done && a.doneBy ? (
                  <span className="sys-comment-meta">{a.doneBy}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {c.replies.length > 0 ? (
        <ul
          className="sys-comment-replies"
          aria-label={repliesText(c.replies.length)}
        >
          {c.replies.map((r) => (
            <li key={r.id}>
              <span className="sys-comment-author">{r.author}</span>
              <span className="sys-comment-body">{r.body}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {reply ? (
        <div className="sys-comment-reply">
          <Composer {...reply} />
        </div>
      ) : null}
      {c.resolved || canResolve ? (
        <div className="sys-comment-footer">
          {c.resolved ? (
            <span className="sys-comment-resolved">
              <SystemIcon name={iconOf("resolve")} size={14} />
              {c.resolvedBy ? `Resolved by ${c.resolvedBy}` : "Resolved"}
            </span>
          ) : null}
          {canResolve ? (
            <Button onClick={() => onResolve(!c.resolved)}>
              {c.resolved ? (
                "Reopen"
              ) : (
                <>
                  <SystemIcon name={iconOf("resolve")} size={14} />
                  {RESOLVE.label}
                </>
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
