import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/Button";
import { BUSY_REASON } from "../ui/disabledReason";
import { limitCommentName } from "../utils/commentAuthor";

type Props = {
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
  busy: boolean;
  postDisabledReason?: string;
};

/**
 * The one-time "who is commenting" step a guest sees on their first Post:
 * a name field that takes focus, and Skip to stay Guest. Enter in the field or Post comment posts.
 */
export function GuestNameStep({
  name,
  onNameChange,
  onConfirm,
  onSkip,
  busy,
  postDisabledReason,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="comment-name-step"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm();
      }}
    >
      <label>
        Your name
        <input
          ref={inputRef}
          value={name}
          autoComplete="off"
          enterKeyHint="send"
          placeholder="Optional"
          onChange={(e) => onNameChange(limitCommentName(e.target.value))}
        />
      </label>
      <Button onClick={onSkip}>Skip</Button>
      <Button
        type="submit"
        variant="primary"
        disabledReason={busy ? BUSY_REASON : postDisabledReason}
        aria-busy={busy || undefined}
      >
        {busy ? "Posting…" : "Post comment"}
      </Button>
    </form>
  );
}
