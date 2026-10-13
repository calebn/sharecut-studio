import { useEffect, useId, useRef, useState } from "react";
import { InlineEditInput } from "./InlineEditInput";

type Props = {
  /** The anchor as it reads: "0:12", or "0:12–0:20" for a span. */
  label: string;
  /** What the person typed: a time, or a span as "0:12–0:20". The caller parses it and returns why it refused, or null. */
  onCommit: (text: string) => string | null;
  /** The selection's time when the comment is not at it. */
  selectionLabel?: string | null;
};

/**
 * The time a new comment lands on, as a chip that turns into a field when
 * pressed. The field holds the whole anchor, so a span stays a span.
 */
export function CommentTimeChip({ label, onCommit, selectionLabel }: Props) {
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const hintId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      chipRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => setRefusal(null), [label]);

  const hint =
    refusal ?? (selectionLabel ? `Selection is ${selectionLabel}` : null);

  if (editing) {
    return (
      <InlineEditInput
        className="comment-time-field"
        aria-label="Comment time"
        size={label.length + 1}
        initial={label}
        onCommit={(text) => setRefusal(onCommit(text))}
        onClose={(restore) => {
          restoreFocus.current = restore;
          setEditing(false);
        }}
      />
    );
  }

  return (
    <span className="comment-time">
      <button
        ref={chipRef}
        type="button"
        className="ui-control comment-time-chip"
        aria-label={`Comment at ${label}. Change time`}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => {
          setRefusal(null);
          setEditing(true);
        }}
      >
        at <span className="comment-time-chip-value">{label}</span>
      </button>
      {hint ? (
        <small
          id={hintId}
          className="comment-time-hint"
          role={refusal ? "alert" : undefined}
        >
          {hint}
        </small>
      ) : null}
    </span>
  );
}
