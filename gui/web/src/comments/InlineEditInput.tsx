import { useLayoutEffect, useRef, useState } from "react";

type Props = {
  initial: string;
  /** Enter or leaving the field. */
  onCommit: (text: string) => void;
  /** Enter and Escape ask to hand focus back to the control that opened it. */
  onClose: (restoreFocus: boolean) => void;
  id?: string;
  "aria-label"?: string;
  className?: string;
  size?: number;
  normalize?: (text: string) => string;
};

/**
 * The field behind an inline "show a value, press to change it" control:
 * opens focused with its text selected; Enter saves, Escape cancels, and
 * leaving the field saves and keeps focus where it landed. Shared by the
 * comment name and the comment time chip.
 */
export function InlineEditInput({
  initial,
  onCommit,
  onClose,
  id,
  "aria-label": ariaLabel,
  className,
  size,
  normalize,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  // Layout effect: iOS raises the keyboard only for a focus inside the tap.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const close = (save: boolean, restoreFocus: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (save) onCommit(draft);
    onClose(restoreFocus);
  };

  return (
    <input
      ref={inputRef}
      id={id}
      className={className}
      aria-label={ariaLabel}
      size={size}
      autoComplete="off"
      enterKeyHint="done"
      value={draft}
      onChange={(e) =>
        setDraft(normalize ? normalize(e.target.value) : e.target.value)
      }
      onBlur={() => close(true, false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          close(true, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(false, true);
        }
      }}
    />
  );
}
