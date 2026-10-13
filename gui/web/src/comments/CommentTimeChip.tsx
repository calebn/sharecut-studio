import { useEffect, useRef, useState } from "react";
import { parseTimecode } from "../utils/time";
import { InlineEditInput } from "./InlineEditInput";

type Props = {
  /** The anchor as it reads: "0:12", or "0:12–0:20" for a span. */
  label: string;
  /** A typed time in seconds; the caller clamps it to the session. */
  onChange: (sec: number) => void;
};

/**
 * The time a new comment lands on, as a chip that turns into a field when
 * pressed. A time that does not parse leaves the anchor as it was.
 */
export function CommentTimeChip({ label, onChange }: Props) {
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
        size={7}
        initial={label.split("–")[0]!}
        onCommit={(text) => {
          const sec = parseTimecode(text);
          if (sec != null) onChange(sec);
        }}
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
