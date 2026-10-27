import { useId } from "react";
import { Avatar, Button } from "../ui";
import { Composer, type ComposerProps } from "./Composer";
import { type AnchorSpan, formatAnchor } from "./composerAnchor";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { iconOf, verbOf } from "./verbDisplay";

export type CommentCardData = {
  id: string;
  author: string;
  /** Absent: a whole-episode note, with no time shown. */
  at?: AnchorSpan;
  body: string;
  resolved: boolean;
  resolvedBy?: string;
  replies: { id: string; author: string; body: string }[];
  actions: { id: string; text: string; done: boolean; doneBy?: string }[];
};

/** Offline-queue state. It comes from a different source than the comment, so it is a prop, not data. */
export type CommentPending =
  | { state: "queued" }
  | { state: "failed"; onRetry: () => void; onRemove: () => void };

export type ReplyComposerProps = Pick<
  ComposerProps,
  "body" | "onBodyChange" | "onSubmit" | "state" | "name" | "inputRef"
>;

/**
 * Announcements belong to the shell's one polite live region
 * (`ui/StatusLiveRegion`), so this part renders no `aria-live`, `role="status"`
 * or `role="alert"`. The caller announces through `statusAnnouncement`:
 * "Comment posted", "Comment saved. It sends when you're back online." and,
 * when a queued comment flips to failed, "Comment not sent. Try again is on
 * the comment."
 */
export type CommentCardProps = {
  comment: CommentCardData;
  pending?: CommentPending;
  selected?: boolean;
  /** Jump the playhead to the comment's time. */
  onSelect?: () => void;
  /** Absent: no Resolve or Reopen. The caller owns the Undo toast. */
  onResolve?: (resolved: boolean) => void;
  /** Absent: action items render as a static list. */
  onToggleAction?: (id: string, done: boolean) => void;
  /** Absent: no reply field (viewer). */
  reply?: ReplyComposerProps;
};

const RESOLVE = verbOf("resolve");
const REMOVE = verbOf("remove");
const PENDING_TEXT = {
  queued: "Waiting to send",
  failed: "Not sent",
} as const;

const repliesText = (count: number) =>
  count === 1 ? "1 reply" : `${count} replies`;

/** A comment with its replies and action items. */
export function CommentCard({
  comment: c,
  pending,
  selected = false,
  onSelect,
  onResolve,
  onToggleAction,
  reply,
}: CommentCardProps) {
  const settled = pending === undefined;
  const canResolve = settled && onResolve !== undefined;
  const canToggle = settled && onToggleAction !== undefined;
  const head = (
    <>
      <span aria-hidden="true">
        <Avatar name={c.author} size="sm" />
      </span>
      <span className="sys-comment-text">
        <span className="sys-comment-by">
          <span className="sys-comment-author">{c.author}</span>
          {c.at ? (
            <span className="sys-mono sys-comment-time">
              {formatAnchor(c.at)}
            </span>
          ) : null}
          {pending ? (
            <span
              className={`sys-comment-pending sys-tone-${pending.state === "queued" ? "warning" : "danger"}`}
            >
              <StatusGlyph
                state={pending.state === "queued" ? "offline" : "failed"}
                size={14}
                text={false}
              />
              {PENDING_TEXT[pending.state]}
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
      data-pending={pending?.state}
    >
      {onSelect ? (
        <button
          type="button"
          className="sys-comment-main"
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
        >
          {head}
        </button>
      ) : (
        <div className="sys-comment-main sys-comment-main--static">{head}</div>
      )}
      {pending?.state === "failed" ? (
        <div className="sys-comment-retry">
          <Button onClick={pending.onRetry}>Try again</Button>
          <Button variant="link" onClick={pending.onRemove}>
            <SystemIcon name={iconOf("remove")} size={14} />
            {REMOVE.label}
          </Button>
        </div>
      ) : null}
      {c.actions.length > 0 ? (
        <ul className="sys-comment-actions" aria-label="Action items">
          {c.actions.map((a) => (
            <li key={a.id}>
              {canToggle ? (
                <ActionToggle
                  action={a}
                  onToggle={(done) => onToggleAction?.(a.id, done)}
                />
              ) : (
                <ActionStatic action={a} />
              )}
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
      {reply && settled ? (
        <div className="sys-comment-reply">
          <Composer
            {...reply}
            compact
            label={`Reply to ${c.author}`}
            placeholder={`Reply to ${c.author}`}
            submitLabel="Reply"
          />
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
            c.resolved ? (
              <Button variant="link" onClick={() => onResolve(false)}>
                Reopen
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onResolve(true)}>
                <SystemIcon name={iconOf("resolve")} size={14} />
                {RESOLVE.label}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Action = CommentCardData["actions"][number];

function ActionToggle({
  action: a,
  onToggle,
}: {
  action: Action;
  onToggle: (done: boolean) => void;
}) {
  const metaId = useId();
  const by = a.done && a.doneBy;
  return (
    <div className="sys-comment-action">
      <label className="sys-comment-action-label">
        <input
          type="checkbox"
          checked={a.done}
          aria-describedby={by ? metaId : undefined}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span data-done={a.done || undefined}>{a.text}</span>
      </label>
      {by ? (
        <span id={metaId} className="sys-comment-meta">
          {a.doneBy}
        </span>
      ) : null}
    </div>
  );
}

function ActionStatic({ action: a }: { action: Action }) {
  return (
    <div className="sys-comment-action">
      <StatusGlyph state={a.done ? "done" : "not-yet"} size={14} />
      <span data-done={a.done || undefined}>{a.text}</span>
      {a.done && a.doneBy ? (
        <span className="sys-comment-meta">{a.doneBy}</span>
      ) : null}
    </div>
  );
}
