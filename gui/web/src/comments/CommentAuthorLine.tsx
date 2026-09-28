import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";

type Props = {
  name: string;
  onChange: (name: string) => void;
};

/** "Commenting as <name> · Change": the name is read-only until Change opens an inline field. */
export function CommentAuthorLine({ name, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const cancelled = useRef(false);

  function start() {
    setDraft(name);
    setEditing(true);
  }

  function finish(save: boolean) {
    if (cancelled.current && save) {
      return;
    }
    if (save) {
      const trimmed = draft.trim();
      if (trimmed) {
        onChange(trimmed);
      }
    }
    setEditing(false);
  }

  useEffect(() => {
    if (editing) {
      cancelled.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasEditing.current) {
      changeRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  if (editing) {
    return (
      <label className="comment-author-edit">
        Your name
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelled.current = true;
              finish(false);
            }
          }}
        />
      </label>
    );
  }

  return (
    <p className="comment-author-line">
      Commenting as <strong>{name}</strong> ·{" "}
      <Button
        ref={changeRef}
        variant="link"
        aria-label="Change your comment name"
        onClick={start}
      >
        Change
      </Button>
    </p>
  );
}
