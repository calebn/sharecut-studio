import {
  type KeyboardEvent,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, Field } from "../ui";
import { useDisabledReasonNote } from "../ui/disabledReason";
import {
  type AnchorIntent,
  type ComposerAnchor,
  formatAnchor,
} from "./composerAnchor";
import { composerBlock, WRITE_REASON } from "./composerBlock";
import { isImeKey } from "./imeKey";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { verbOf } from "./verbDisplay";

export type BodyEdit = { composing: boolean; undo: boolean };

export type ComposerState = "idle" | "posting" | "offline";

/**
 * Announcements belong to the shell's one polite live region
 * (`ui/StatusLiveRegion`), so this part renders no `aria-live`, `role="status"`
 * or `role="alert"`. The caller announces through `statusAnnouncement`:
 * "Comment posted" when accepted, "Comment saved. It sends when you're back
 * online." when queued, and "Comment not sent. Try again is on the comment."
 * when a queued comment flips to failed.
 */
export type ComposerProps = {
  body: string;
  onBodyChange: (value: string, edit?: BodyEdit) => void;
  /** Fires only when Post can fire. The caller clears `body` once the send is
   *  accepted, not before. A send failure shows on the CommentCard, never here. */
  onSubmit: () => void;
  /** The leading chip. Omit for no chip at all (replies). */
  anchor?: ComposerAnchor;
  /** Absent: the chip is static text with no clear control. */
  onAnchor?: (intent: AnchorIntent) => void;
  /** Guest first post. A blank name posts as "Guest" (the caller maps it). Never blocks Post. */
  name?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    saved?: boolean;
    postedRev?: number;
  };
  /** Offline posts to the queue: the label is "Queue comment" and the offline status glyph shows. */
  state?: ComposerState;
  /** Accessible name of the field. Default "Comment". */
  label?: string;
  submitLabel?: string;
  placeholder?: string;
  /** Escape in the name or comment field (not during an IME composition). */
  onEscape?: () => void;
  /** One line that grows to four (reply, phone dock). */
  compact?: boolean;
  /** Say why Post is off while the field is empty. Reply and Ask fields keep only the busy reason. */
  explainEmpty?: boolean;
  /** Phone listen layout: a leading Close (x) that hides the field and keeps the text. */
  onClose?: () => void;
  /** Focus from outside: C on a mounted card, the guest's first key press. */
  inputRef?: Ref<HTMLTextAreaElement>;
};

const COMMENT = verbOf("comment");
const QUEUE_LABEL = "Queue comment";
const POSTING_LABEL = "Posting…";

/** Coarse pointers (a phone soft keyboard has no Shift) keep Return as a new line. */
function isCoarsePointer(): boolean {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(pointer: coarse)").matches
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * The comment field. The anchor chip leads inside the field and pins on the
 * first keystroke, so the comment lands where the person started to type. On a
 * fine pointer Enter posts, Shift+Enter adds a line and Cmd or Ctrl+Enter also
 * posts. On a coarse pointer Return adds a line and the arrow posts.
 *
 * The anchor is the caller's: it passes `anchor` and applies the `onAnchor`
 * intents with `nextAnchor`.
 */
export function Composer(props: ComposerProps) {
  const {
    body,
    onBodyChange,
    onSubmit,
    anchor,
    onAnchor,
    name,
    state = "idle",
    label = COMMENT.label,
    submitLabel = "Post",
    placeholder = "Add a comment",
    compact = false,
    onEscape,
    onClose,
    inputRef,
    explainEmpty = false,
  } = props;
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const knownName = name?.saved === true && !renaming;
  const who = name?.value.trim() || "Guest";
  useEffect(() => {
    if (renaming) nameRef.current?.focus();
  }, [renaming]);
  // Each post that went through saved the name, so the row folds back.
  const postedRev = name?.postedRev;
  const [seenRev, setSeenRev] = useState(postedRev);
  if (postedRev !== seenRev) {
    setSeenRev(postedRev);
    setRenaming(false);
  }
  // Posting from the name field unmounts it, which would drop focus to the page.
  const lastRev = useRef(postedRev);
  useEffect(() => {
    const posted = postedRev !== lastRev.current;
    lastRev.current = postedRev;
    if (posted && document.activeElement === document.body)
      bodyRef.current?.focus();
  }, [postedRev]);
  const setBodyRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      bodyRef.current = node;
      assignRef(inputRef, node);
    },
    [inputRef],
  );
  // Escape from any control inside (name, comment, chip, Post).
  const onRootKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !onEscape || isImeKey(event)) return;
    event.stopPropagation();
    onEscape();
  };
  const block = composerBlock(props);
  const reason = useDisabledReasonNote(
    block === WRITE_REASON && !explainEmpty ? undefined : block,
    "sys-composer-note",
  );
  const posting = state === "posting";
  const offline = state === "offline";
  const coarse = isCoarsePointer();
  const sendLabel = posting
    ? POSTING_LABEL
    : offline
      ? QUEUE_LABEL
      : submitLabel;

  const onBodyKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || isImeKey(event)) return;
    const chord = event.metaKey || event.ctrlKey;
    if (!chord && (event.shiftKey || isCoarsePointer())) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (block === undefined) onSubmit();
  };

  const onNameKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || isImeKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.metaKey || event.ctrlKey) {
      if (block === undefined) onSubmit();
    } else {
      bodyRef.current?.focus();
    }
  };

  return (
    <div
      role="presentation"
      onKeyDown={onRootKeyDown}
      className="sys-composer"
      data-state={state}
      data-compact={compact || undefined}
    >
      {name && knownName ? (
        <div className="sys-composer-who sys-composer-known">
          <span className="sys-composer-avatar" aria-hidden="true">
            <SystemIcon name="user" size={16} />
          </span>
          <span className="sys-composer-as">
            Posting as <strong>{who}</strong>
          </span>
          <Button
            aria-label={`Change name, posting as ${who}`}
            className="sys-composer-change"
            onClick={() => setRenaming(true)}
          >
            Change name
          </Button>
        </div>
      ) : name ? (
        <div className="sys-composer-who">
          <span className="sys-composer-avatar" aria-hidden="true">
            <SystemIcon name="user" size={16} />
          </span>
          <Field label="Your name" className="sys-composer-name">
            {(control) => (
              <input
                {...control}
                ref={nameRef}
                className="sys-composer-input"
                value={name.value}
                placeholder={
                  name.placeholder ?? "Name, so the host knows who said it"
                }
                onChange={(event) => name.onChange(event.target.value)}
                autoComplete="name"
                enterKeyHint="next"
                readOnly={posting}
                onKeyDown={onNameKeyDown}
              />
            )}
          </Field>
        </div>
      ) : null}
      <div className="sys-composer-field">
        {onClose ? (
          <button
            type="button"
            className="sys-icon-btn sys-composer-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <SystemIcon name="x" size={16} />
          </button>
        ) : null}
        {anchor ? (
          <AnchorChip
            anchor={anchor}
            onAnchor={posting ? undefined : onAnchor}
            focusFallback={bodyRef}
          />
        ) : null}
        <textarea
          className="sys-composer-body"
          aria-label={label}
          aria-keyshortcuts={coarse ? undefined : "Enter"}
          enterKeyHint={coarse ? "enter" : "send"}
          value={body}
          placeholder={placeholder}
          rows={compact ? 1 : 3}
          readOnly={posting}
          ref={setBodyRef}
          onChange={(event) => {
            if (anchor?.kind === "follow") onAnchor?.("pin");
            const native = event.nativeEvent as InputEvent;
            onBodyChange(event.target.value, {
              composing: native.isComposing === true,
              undo: native.inputType === "historyUndo",
            });
          }}
          onKeyDown={onBodyKeyDown}
          onCompositionEnd={(event) => {
            if (event.currentTarget.value === "")
              onBodyChange("", { composing: false, undo: false });
          }}
        />
        <Button
          className="sys-composer-submit"
          aria-label={sendLabel}
          disabledReason={block}
          {...reason.describedBy}
          aria-busy={posting || undefined}
          aria-disabled={posting || undefined}
          onClick={() => {
            onSubmit();
            bodyRef.current?.focus();
          }}
        >
          {posting ? (
            <SystemIcon name="progress-ring" size={16} />
          ) : offline ? (
            <StatusGlyph state="offline" size={16} text={false} />
          ) : (
            <SystemIcon name="arrow-up" size={16} />
          )}
        </Button>
      </div>
      {reason.note}
    </div>
  );
}

function chipView(anchor: ComposerAnchor): {
  text: string;
  pinned: boolean;
  name: string;
  state: string;
} {
  switch (anchor.kind) {
    case "follow": {
      const text = formatAnchor({ start: anchor.seconds });
      return {
        text,
        pinned: false,
        name: `Comment at ${text}, follows the playhead. Pin it here`,
        state: "Follows the playhead",
      };
    }
    case "pinned": {
      const text = formatAnchor(anchor);
      const range = anchor.end === undefined ? `at ${text}` : text;
      return {
        text,
        pinned: true,
        name: `Pinned ${range}. Move to the playhead`,
        state: "Pinned",
      };
    }
    case "episode":
      return {
        text: "Whole episode",
        pinned: false,
        name: "Whole-episode note. Pin to the playhead",
        state: "",
      };
  }
}

function AnchorChip({
  anchor,
  onAnchor,
  focusFallback,
}: {
  anchor: ComposerAnchor;
  onAnchor?: (intent: AnchorIntent) => void;
  /** Takes focus when the chip button unmounts while it holds focus (posting swaps it for text). */
  focusFallback: RefObject<HTMLElement | null>;
}) {
  const view = chipView(anchor);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const setChip = useCallback(
    (node: HTMLButtonElement | null) => {
      chipRef.current = node;
      return () => {
        if (node && node === document.activeElement)
          focusFallback.current?.focus();
      };
    },
    [focusFallback],
  );
  const body = (
    <>
      {view.pinned ? <SystemIcon name="pin" size={12} /> : null}
      <span className={anchor.kind === "episode" ? undefined : "sys-mono"}>
        {view.text}
      </span>
    </>
  );
  if (!onAnchor) {
    return (
      <span className="sys-composer-anchor">
        <span
          className="sys-composer-chip"
          data-pinned={view.pinned || undefined}
        >
          {body}
          {view.state ? <span className="sr-only">{view.state}</span> : null}
        </span>
      </span>
    );
  }
  return (
    <span className="sys-composer-anchor">
      <button
        type="button"
        className="sys-composer-chip"
        data-pinned={view.pinned || undefined}
        aria-label={view.name}
        ref={setChip}
        onClick={() => onAnchor("here")}
      >
        {body}
      </button>
      {anchor.kind === "episode" ? null : (
        <button
          type="button"
          className="sys-composer-clear"
          aria-label="Make it a whole-episode note"
          onClick={() => {
            onAnchor("episode");
            chipRef.current?.focus();
          }}
        >
          <SystemIcon name="x" size={12} />
        </button>
      )}
    </span>
  );
}
