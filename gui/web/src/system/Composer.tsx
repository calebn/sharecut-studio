import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { Button, Field } from "../ui";
import { composerBlock } from "./composerBlock";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { formatSeconds } from "./seconds";
import { verbOf } from "./verbDisplay";

export type ComposerState = "idle" | "posting" | "offline";

export type ComposerProps = {
  body: string;
  onBodyChange: (value: string) => void;
  onSubmit: () => void;
  /** Leading chip inside the field. Omit for an unanchored comment. */
  time?: { seconds: number; pinned: boolean };
  /** Fires on the first keystroke while `time.pinned` is false; the caller then sets `pinned: true`. */
  onPinTime?: () => void;
  /** Click the pinned chip to unpin and follow the playhead again. */
  onUnpinTime?: () => void;
  /** Guest first post: a plain "Your name" field above the body. */
  name?: {
    value: string;
    onChange: (value: string) => void;
    required?: boolean;
  };
  /** Offline posts to the queue: the label is "Queue comment" and the offline status glyph shows. */
  state?: ComposerState;
  /** Why the field is read-only, such as a viewer role. */
  disabledReason?: string;
  submitLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Phone: one line that grows. */
  compact?: boolean;
};

const COMMENT = verbOf("comment");
const QUEUE_LABEL = "Queue comment";

/**
 * The comment field. The time chip leads inside the field and pins on the
 * first keystroke, so the comment lands where the person started to type.
 * Cmd or Ctrl+Enter posts.
 */
export function Composer(props: ComposerProps) {
  const {
    body,
    onBodyChange,
    onSubmit,
    time,
    onPinTime,
    onUnpinTime,
    name,
    state = "idle",
    disabledReason,
    submitLabel = "Post",
    placeholder = "Add a comment",
    autoFocus,
    compact = false,
  } = props;
  const noteId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus();
  }, [autoFocus]);
  const block = composerBlock(props);
  const readOnly = disabledReason !== undefined || state === "posting";
  const posting = state === "posting";
  const offline = state === "offline";
  const label = posting ? "Posting…" : offline ? QUEUE_LABEL : submitLabel;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (block === undefined) onSubmit();
  };

  return (
    <div
      className="sys-composer"
      data-state={state}
      data-compact={compact || undefined}
    >
      {name ? (
        <Field label="Your name" className="sys-composer-name">
          {(control) => (
            <input
              {...control}
              className="sys-composer-input"
              value={name.value}
              onChange={(event) => name.onChange(event.target.value)}
              required={name.required}
              autoComplete="name"
              readOnly={readOnly}
              onKeyDown={onKeyDown}
            />
          )}
        </Field>
      ) : null}
      <div className="sys-composer-field">
        {time ? (
          <TimeChip
            time={time}
            onUnpin={disabledReason ? undefined : onUnpinTime}
          />
        ) : null}
        <textarea
          className="sys-composer-body"
          aria-label={COMMENT.label}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          aria-describedby={disabledReason ? noteId : undefined}
          value={body}
          placeholder={placeholder}
          rows={compact ? 1 : 3}
          readOnly={readOnly}
          ref={bodyRef}
          onChange={(event) => {
            if (time && !time.pinned) onPinTime?.();
            onBodyChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          variant="primary"
          className="sys-composer-submit"
          disabledReason={block}
          aria-busy={posting || undefined}
          onClick={() => onSubmit()}
        >
          {offline ? (
            <StatusGlyph state="offline" size={14} text={false} />
          ) : null}
          {label}
        </Button>
      </div>
      {disabledReason ? (
        <p id={noteId} className="sys-composer-note">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

function TimeChip({
  time,
  onUnpin,
}: {
  time: NonNullable<ComposerProps["time"]>;
  onUnpin?: () => void;
}) {
  const text = formatSeconds(time.seconds);
  if (time.pinned && onUnpin) {
    return (
      <button
        type="button"
        className="sys-composer-chip"
        data-pinned
        aria-label={`Pinned at ${text}. Follow the playhead`}
        onClick={onUnpin}
      >
        <SystemIcon name="pin" size={12} />
        <span className="sys-mono">{text}</span>
      </button>
    );
  }
  return (
    <span className="sys-composer-chip" data-pinned={time.pinned || undefined}>
      {time.pinned ? <SystemIcon name="pin" size={12} /> : null}
      <span className="sys-mono">{text}</span>
      <span className="sr-only">
        {time.pinned ? "Pinned" : "Follows the playhead"}
      </span>
    </span>
  );
}
