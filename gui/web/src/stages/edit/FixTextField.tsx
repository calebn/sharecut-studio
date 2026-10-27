import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
   * leaving cancels: a rename inside a popover applies on Enter only.
   */
  commitOnBlur?: boolean;
};

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

const messageOf = (reason: unknown) =>
  reason instanceof Error && reason.message
    ? reason.message
    : "That did not save. Try again.";

/**
 * The inline field the selected words become (spec POP-WORD-EDIT): sized to
 * its content, 1 px accent outline, the text's own font. It takes focus and
 * selects its text on mount, and the Script pane hands focus back to the first
 * word it covered when the host closes it. Text changes never move audio, so
 * the field reports words only.
 *
 * A commit the host refuses leaves the field open, read only while the host
 * works, with the reason under it. Only Enter, Tab and a leaving click or
 * focus commit: a field that is removed (undo, a remote edit, another
 * selection) saves no draft.
 */
export function FixTextField({
  value,
  label,
  onDone,
  validate,
  commitOnBlur = true,
}: FixTextFieldProps) {
  const [original] = useState(value);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const errorId = useId();

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = useStableCallback(async (via: FixTextVia) => {
    if (finished.current) return;
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

  // Native, so the element's own connectedness is read: a blur fired while the
  // field is being removed is not the person leaving it.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onBlur = () => {
      if (el.isConnected) void finish("blur");
    };
    el.addEventListener("blur", onBlur);
    return () => el.removeEventListener("blur", onBlur);
  }, [finish]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void finish("enter");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish("escape");
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      void finish("tab");
    }
  };

  return (
    <>
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
        style={
          { "--sys-fix-chars": Math.max(draft.length, 1) } as CSSProperties
        }
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <InlineError message={error} id={errorId} inline />
    </>
  );
}
