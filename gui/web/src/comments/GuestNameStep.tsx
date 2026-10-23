import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/Button";
import { COMMENT_NAME_MAX } from "../utils/commentAuthor";

type Props = {
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
};

/**
 * The one-time "who is commenting" step a guest sees on their first Post:
 * a name field that takes focus, and Skip to stay Guest. Enter in the field posts.
 */
export function GuestNameStep({
  name,
  onNameChange,
  onConfirm,
  onSkip,
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
          maxLength={COMMENT_NAME_MAX}
          autoComplete="nickname"
          enterKeyHint="send"
          placeholder="Optional"
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>
      <Button onClick={onSkip}>Skip</Button>
    </form>
  );
}
