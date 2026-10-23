import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { limitCommentName } from "../utils/commentAuthor";
import { InlineEditInput } from "./InlineEditInput";

type Props = {
  name: string;
  onChange: (name: string) => void;
};

/**
 * "Commenting as <name> · Change": the name is read-only until Change opens an
 * inline field (`InlineEditInput`). Focus goes back to Change only after
 * Enter / Escape; a blur keeps focus where it landed.
 */
export function CommentAuthorLine({ name, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const fieldId = useId();

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      changeRef.current?.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <label className="comment-author-edit" htmlFor={fieldId}>
        Your name
        <InlineEditInput
          id={fieldId}
          initial={name}
          normalize={limitCommentName}
          onCommit={(text) => {
            const trimmed = text.trim();
            if (trimmed) onChange(trimmed);
          }}
          onClose={(restore) => {
            restoreFocus.current = restore;
            setEditing(false);
          }}
        />
      </label>
    );
  }

  return (
    <p className="comment-author-line">
      Commenting as <strong>{name}</strong>{" "}
      <span className="comment-author-change">
        ·{" "}
        <Button
          ref={changeRef}
          variant="link"
          aria-label="Change your comment name"
          onClick={() => setEditing(true)}
        >
          Change
        </Button>
      </span>
    </p>
  );
}
