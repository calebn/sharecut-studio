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
  replies: {
    id: string;
    author: string;
    body: string;
    /** A reply the host has not taken yet. */
    pending?: "queued" | "sending";
  }[];
  actions: { id: string; text: string; done: boolean; doneBy?: string }[];
};

/** Offline-queue state. It comes from a different source than the comment, so it is a prop, not data. */
export type CommentPending =
  | {
      state: "queued";
      /** The send is on its way; it can no longer be called back. */
      sending?: boolean;
      /** Absent: the comment waits with no way to call it back. */
      onDontSend?: () => void;
    }
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
  /** Calls back a reply that has not been sent yet. */
  onDontSendReply?: (replyId: string) => void;
};

const RESOLVE = verbOf("resolve");
const REMOVE = verbOf("remove");
const PENDING_TEXT = {
  queued: "Waiting to send",
  sending: "Sending…",
  failed: "Not sent",
} as const;
const DONT_SEND = "Don't send";
const SENDING_REASON = "It's on its way, so it can't be called back.";

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
  onDontSendReply,
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
              {onSelect ? <SystemIcon name="play" size={12} /> : null}
              {formatAnchor(c.at)}
            </span>
          ) : null}
          {pending ? (
            <span
              className={`sys-comment-pending sys-tone-${pending.state === "queued" ? "warning" : "danger"}`}
            >
              <StatusGlyph state={pending.state} size={14} text={false} />
              {
                PENDING_TEXT[
                  pending.state === "queued" && pending.sending
                    ? "sending"
                    : pending.state
                ]
              }
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
        <div className="sys-comment-main">{head}</div>
      )}
      {pending?.state === "queued" && pending.onDontSend ? (
        <div className="sys-comment-retry">
          <Button
            variant="link"
            aria-label={`${DONT_SEND}: comment by ${c.author}`}
            disabledReason={pending.sending ? SENDING_REASON : undefined}
            onClick={() => pending.onDontSend?.()}
          >
            {DONT_SEND}
          </Button>
        </div>
      ) : null}
      {pending?.state === "failed" ? (
        <div className="sys-comment-retry">
          <Button
            aria-label={`Try again: comment by ${c.author}`}
            onClick={() => pending.onRetry()}
          >
            Try again
          </Button>
          <Button
            variant="link"
            aria-label={`${REMOVE.label}: comment by ${c.author}`}
            onClick={() => pending.onRemove()}
          >
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
              {r.pending ? (
                <>
                  <span className="sys-comment-pending sys-tone-warning">
                    <StatusGlyph state="queued" size={14} text={false} />
                    {
                      PENDING_TEXT[
                        r.pending === "sending" ? "sending" : "queued"
                      ]
                    }
                  </span>
                  {onDontSendReply ? (
                    <Button
                      variant="link"
                      aria-label={`${DONT_SEND}: reply by ${r.author}`}
                      disabledReason={
                        r.pending === "sending" ? SENDING_REASON : undefined
                      }
                      onClick={() => onDontSendReply(r.id)}
                    >
                      {DONT_SEND}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {reply && settled ? (
        <div className="sys-comment-reply">
          <Composer
            body={reply.body}
            onBodyChange={reply.onBodyChange}
            onSubmit={reply.onSubmit}
            state={reply.state}
            name={reply.name}
            inputRef={reply.inputRef}
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
