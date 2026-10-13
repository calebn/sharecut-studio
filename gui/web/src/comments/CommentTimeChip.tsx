import { useEffect, useRef, useState } from "react";
import { InlineEditInput } from "./InlineEditInput";

type Props = {
  /** The anchor as it reads: "0:12", or "0:12–0:20" for a span. */
  label: string;
  /** What the person typed: a time, or a span as "0:12–0:20". The caller parses it. */
  onCommit: (text: string) => void;
};

/**
 * The time a new comment lands on, as a chip that turns into a field when
 * pressed. The field holds the whole anchor, so a span stays a span.
 */
export function CommentTimeChip({ label, onCommit }: Props) {
  const [editing, setEditing] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      chipRef.current?.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <InlineEditInput
        className="comment-time-field"
        aria-label="Comment time"
        size={label.length + 1}
        initial={label}
        onCommit={onCommit}
        onClose={(restore) => {
          restoreFocus.current = restore;
          setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      ref={chipRef}
      type="button"
      className="ui-control comment-time-chip"
      aria-label={`Comment at ${label}. Change time`}
      onClick={() => setEditing(true)}
    >
      at <span className="comment-time-chip-value">{label}</span>
    </button>
  );
}
