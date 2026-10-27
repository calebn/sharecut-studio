import {
  type CSSProperties,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** How the field closed: Enter, Tab (the host steps on to the next unsure word), a click or focus moving away, or Esc. */
type FixTextVia = "enter" | "tab" | "blur" | "escape";

type FixTextFieldProps = {
  /** The words as they are now, joined with spaces. */
  value: string;
  /** What a screen reader calls the field: "Fix text", "Fix text, 3 words". */
  label: string;
  /**
   * The field is done. `text` is the new words, or null when nothing should
   * change: Esc, an empty field, or the same words. Called once.
   */
  onDone: (text: string | null, via: FixTextVia) => void;
};

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * The inline field the selected words become (spec POP-WORD-EDIT): sized to
 * its content, 1 px accent outline, the text's own font. It takes focus and
 * selects its text on mount, and the Script pane hands focus back to the first
 * word it covered when the host closes it. Text changes never move audio, so
 * the field reports words only.
 */
export function FixTextField({ value, label, onDone }: FixTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (via: FixTextVia) => {
    if (finished.current) return;
    finished.current = true;
    const text = squash(draft);
    onDone(
      via === "escape" || text === "" || text === value ? null : text,
      via,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish("enter");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish("escape");
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      finish("tab");
    }
  };

  return (
    <input
      ref={input}
      className="sys-edit-fix"
      type="text"
      aria-label={label}
      autoComplete="off"
      spellCheck
      value={draft}
      style={{ "--sys-fix-chars": Math.max(draft.length, 1) } as CSSProperties}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish("blur")}
    />
  );
}
