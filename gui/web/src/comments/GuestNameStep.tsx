import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/Button";
import { COMMENT_NAME_MAX } from "../utils/commentAuthor";

type Props = {
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
  onCancel: () => void;
};

/**
 * The one-time "who is commenting" step a guest sees on their first Post:
 * a name field that takes focus, and Skip to stay Guest. Enter posts, Escape
 * goes back to the comment.
 */
export function GuestNameStep({
  name,
  onNameChange,
  onConfirm,
  onSkip,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="comment-name-step">
      <label>
        Your name
        <input
          ref={inputRef}
          value={name}
          maxLength={COMMENT_NAME_MAX}
          autoComplete="nickname"
          enterKeyHint="send"
          placeholder="Optional"
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </label>
      <Button onClick={onSkip}>Skip</Button>
    </div>
  );
}
