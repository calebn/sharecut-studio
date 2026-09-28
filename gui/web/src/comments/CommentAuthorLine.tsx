import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";

type Props = {
  name: string;
  onChange: (name: string) => void;
};

/**
 * "Commenting as <name> · Change": the name is read-only until Change opens an
 * inline field. Focus goes back to Change only after Enter / Escape (a blur
 * keeps focus where it landed), the same rule as
 * `transcript/InlineWordEditor.tsx`'s `onClose(restoreFocus)`. A third
 * inline-edit field should reuse one of these rather than add another variant.
 */
export function CommentAuthorLine({ name, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
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
    } else if (restoreFocus.current) {
      // Only Enter / Escape inside the field hand focus back to Change;
      // a blur already moved focus where the user wanted it.
      restoreFocus.current = false;
      changeRef.current?.focus();
    }
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
              restoreFocus.current = true;
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              restoreFocus.current = true;
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
