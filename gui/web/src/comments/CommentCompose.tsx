import type { ReactNode } from "react";
import { Button } from "../ui";

type Props = {
  body: string;
  onBodyChange: (value: string) => void;
  busy?: boolean;
  submitLabel?: string;
  onSubmit: () => void;
  /** Where the comment lands, shown beside the submit button. */
  anchor?: ReactNode;
  bodyPlaceholder?: string;
  bodyRows?: number;
  className?: string;
  author?: string;
  onAuthorChange?: (value: string) => void;
  authorLabel?: string;
  children?: ReactNode;
};

/**
 * Shared comment compose shell: optional author, body, extra fields, then
 * the anchor and submit on one row. Submit enables once the body has text.
 */
export function CommentCompose({
  body,
  onBodyChange,
  busy = false,
  submitLabel = "Post comment",
  onSubmit,
  anchor,
  bodyPlaceholder = "Feedback…",
  bodyRows = 3,
  className = "comment-compose",
  author,
  onAuthorChange,
  authorLabel = "Your name",
  children,
}: Props) {
  return (
    <div className={className}>
      {author != null && onAuthorChange ? (
        <label>
          {authorLabel}
          <input
            value={author}
            onChange={(e) => onAuthorChange(e.target.value)}
            placeholder="display name"
          />
        </label>
      ) : null}
      <textarea
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        aria-label="Comment"
        placeholder={bodyPlaceholder}
        rows={bodyRows}
      />
      {children}
      <div className="comment-compose-submit">
        {anchor}
        <Button
          variant="primary"
          disabled={busy || !body.trim()}
          aria-busy={busy || undefined}
          onClick={() => onSubmit()}
        >
          {busy ? "Posting…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
