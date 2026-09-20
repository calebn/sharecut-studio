import type { ReactNode } from "react";
import { Button } from "../ui";

type Props = {
  body: string;
  onBodyChange: (value: string) => void;
  busy?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  onSubmit: () => void;
  hint?: ReactNode;
  bodyPlaceholder?: string;
  className?: string;
  author?: string;
  onAuthorChange?: (value: string) => void;
  authorLabel?: string;
  children?: ReactNode;
};

/** Shared comment compose shell (optional author + body + submit). */
export function CommentCompose({
  body,
  onBodyChange,
  busy = false,
  submitLabel = "Post comment",
  submitDisabled,
  onSubmit,
  hint,
  bodyPlaceholder = "Feedback…",
  className = "comment-compose",
  author,
  onAuthorChange,
  authorLabel = "Your name",
  children,
}: Props) {
  return (
    <div className={className}>
      {hint}
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
        placeholder={bodyPlaceholder}
        rows={3}
      />
      {children}
      <Button
        variant="primary"
        disabled={busy || submitDisabled}
        aria-busy={busy || undefined}
        onClick={() => onSubmit()}
      >
        {busy ? "Posting…" : submitLabel}
      </Button>
    </div>
  );
}
