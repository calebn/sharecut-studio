import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { BUSY_REASON } from "../ui/disabledReason";
import { limitCommentName } from "../utils/commentAuthor";

const PROMPT = "Add your name to post your comment, or choose Post as Guest.";

type Props = {
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onPostAsGuest: () => void;
  busy: boolean;
  postDisabledReason?: string;
};

/**
 * The one-time "who is commenting" step a guest sees on their first Post:
 * a name field that takes focus, and Post as Guest to post under Guest. Enter in the field or Post comment posts.
 */
export function GuestNameStep({
  name,
  onNameChange,
  onConfirm,
  onPostAsGuest,
  busy,
  postDisabledReason,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [prompt, setPrompt] = useState("");

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A live region announces a change, not a region that mounts already filled.
  useEffect(() => {
    const timer = setTimeout(() => setPrompt(PROMPT), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <form
      className="comment-name-step"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm();
      }}
    >
      <p className="sr-only" role="status">
        {prompt}
      </p>
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
      <Button
        disabledReason={busy ? BUSY_REASON : postDisabledReason}
        onClick={onPostAsGuest}
      >
        Post as Guest
      </Button>
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
