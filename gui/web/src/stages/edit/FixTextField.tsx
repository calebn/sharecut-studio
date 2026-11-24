import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SystemIcon } from "../../system/SystemIcon";
import { InlineError } from "../../ui/InlineError";
import { useStableCallback } from "../../utils/useStableCallback";

/** How the field closed: Enter, Tab (the host steps on to the next unsure word), a click or focus moving away, or Esc. */
export type FixTextVia = "enter" | "tab" | "blur" | "escape";

/**
 * What the host answers to a commit. Nothing means it took. A string, or a
 * promise that resolves to one, is the reason it did not, and a rejection
 * counts as a failure too: the field stays open with the typing in it.
 */
export type FixTextAnswer = void | string | Promise<void | string>;

type FixTextFieldProps = {
  /** The words as they are now, joined with spaces. */
  value: string;
  /** What a screen reader calls the field: "Fix text", "Fix text, 3 words". */
  label: string;
  /**
   * The field is done. `text` is the new words, or null when nothing should
   * change: Esc, leaving an empty field, or the same words. An empty field
   * at Enter or Tab stays open with "Text cannot be empty." (as the legacy
   * editor did), unless `validate` speaks for it. `original` is the words
   * the field opened with, which the host sends as the expected text so the
   * backend can refuse a stale correction. A null `text` always closes.
   */
  onDone: (
    text: string | null,
    via: FixTextVia,
    original: string,
  ) => FixTextAnswer;
  /**
   * Checked before a commit, with the squeezed text (empty included). A
   * message keeps the field open with that message under it.
   */
  validate?: (text: string) => string | undefined;
  /**
   * Leaving the field commits, as the stage rules say (design-system 1.4). Off,
   * leaving cancels: a rename inside a popover applies on Enter only, and Tab
   * moves focus on like any leave instead of committing.
   */
  commitOnBlur?: boolean;
  /** Typing to start from instead of `value`, for a field that was remounted. */
  initialDraft?: string;
  /** Called with the raw typing on every change, so a host can keep it across a remount. */
  onDraftChange?: (draft: string) => void;
  /**
   * Draws a Cancel button that discards the typing, named by this label.
   * Leaving the field by any other way still follows `commitOnBlur`.
   */
  cancelLabel?: string;
};

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

const messageOf = (reason: unknown) =>
  reason instanceof Error && reason.message
    ? reason.message
    : "That did not save. Try again.";

/**
 * The inline field the selected words become (spec POP-WORD-EDIT): sized to
 * its content, 1 px accent outline, the text's own font. It takes focus and
 * selects its text on mount. The host returns focus to a word only when this
 * field still owns focus as it closes; a blur save leaves focus on the
 * destination the user chose. Text changes never move audio, so the field
 * reports words only.
 *
 * A commit the host refuses leaves the field open, read only while the host
 * works, with the reason under it. Only Enter and, while leaving commits, Tab
 * and a leaving click or focus commit: a field that is removed (undo, a remote edit, another
 * selection) saves no draft.
 */
export function FixTextField({
  value,
  label,
  onDone,
  validate,
  commitOnBlur = true,
  initialDraft,
  onDraftChange,
  cancelLabel,
}: FixTextFieldProps) {
  const [original] = useState(value);
  const [draft, setDraft] = useState(initialDraft ?? value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const cancelArmed = useRef(false);
  const errorId = useId();

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = useStableCallback(async (via: FixTextVia) => {
    if (finished.current) return;
    cancelArmed.current = false;
    const text = squash(draft);
    if (via === "escape") {
      finished.current = true;
      void onDone(null, via, original);
      return;
    }
    if (via === "blur" && !commitOnBlur) {
      finished.current = true;
      void onDone(null, via, original);
      return;
    }
    const invalid = validate?.(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (text === "" && !validate && via !== "blur") {
      setError("Text cannot be empty.");
      return;
    }
    if (text === "" || text === original) {
      finished.current = true;
      void onDone(null, via, original);
      return;
    }
    finished.current = true;
    setError(null);
    setBusy(true);
    try {
      const answer = await onDone(text, via, original);
      if (typeof answer === "string" && answer !== "") {
        finished.current = false;
        setError(answer);
      }
    } catch (reason) {
      finished.current = false;
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  });

  // A connected blur can precede synchronous DOM retirement, so decide after it settles.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    let active = true;
    const onBlur = () => {
      if (!el.isConnected) return;
      queueMicrotask(() => {
        if (active && input.current === el && el.isConnected) {
          void finish(cancelArmed.current ? "escape" : "blur");
        }
      });
    };
    const onFocus = () => {
      cancelArmed.current = false;
    };
    el.addEventListener("blur", onBlur);
    el.addEventListener("focus", onFocus);
    return () => {
      active = false;
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("focus", onFocus);
    };
  }, [finish]);

  useEffect(() => {
    const disarm = () => {
      cancelArmed.current = false;
    };
    document.addEventListener("visibilitychange", disarm);
    return () => document.removeEventListener("visibilitychange", disarm);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void finish("enter");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish("escape");
    } else if (event.key === "Tab" && !event.shiftKey && commitOnBlur) {
      event.preventDefault();
      void finish("tab");
    }
  };

  const field = (
    <span className="sys-edit-fix-field">
      <span className="sys-edit-fix-measure" aria-hidden="true">
        {draft || " "}
      </span>
      <input
        ref={input}
        className="sys-edit-fix"
        type="text"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        spellCheck
        readOnly={busy}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onDraftChange?.(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
    </span>
  );

  return (
    <>
      {cancelLabel ? (
        <span className="sys-edit-fix-with-cancel">
          {field}
          <button
            type="button"
            className="sys-icon-btn sys-edit-fix-cancel"
            tabIndex={-1}
            aria-label={cancelLabel}
            aria-disabled={busy || undefined}
            title={`${cancelLabel} (Esc)`}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              event.stopPropagation();
              cancelArmed.current = true;
            }}
            onPointerCancel={() => {
              cancelArmed.current = false;
            }}
            onClick={() => {
              if (!busy) void finish("escape");
            }}
          >
            <SystemIcon name="x" size={16} />
          </button>
        </span>
      ) : (
        field
      )}
      <InlineError message={error} id={errorId} inline />
    </>
  );
}
