import { useEffect, useEffectEvent, useRef, useState } from "react";

export type InlineEditEnd = "enter" | "escape" | "blur";

type Props = {
  /** Accessible name; the field shows no visible label. */
  label: string;
  value: string;
  /** Called once per changed value, on Enter, on blur and when the field goes away. */
  onCommit: (value: string) => void;
  /** After the field finishes by Enter, Escape or blur. Not called when it unmounts. */
  onEnd?: (how: InlineEditEnd) => void;
  /** Enter commits; Shift+Enter breaks the line. */
  multiline?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
};

/**
 * A text value edited where it is read. It looks like text until hovered or
 * focused. Enter and blur commit, Escape puts the value back, and a value
 * already sent is never sent twice.
 */
export function InlineEdit({
  label,
  value,
  onCommit,
  onEnd,
  multiline = false,
  autoFocus = false,
  placeholder,
  className,
}: Props) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const sent = useRef(value);
  const cancelled = useRef(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!autoFocus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  useEffect(() => {
    sent.current = value;
  }, [value]);
  const commit = () => {
    if (cancelled.current || text === sent.current) return;
    sent.current = text;
    onCommit(text);
  };
  const leave = useEffectEvent(commit);
  useEffect(() => () => leave(), []);
  const change = (next: string) => {
    cancelled.current = false;
    setText(next);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelled.current = true;
      setText(value);
      onEnd?.("escape");
    } else if (
      event.key === "Enter" &&
      !(multiline && event.shiftKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      commit();
      onEnd?.("enter");
    }
  };
  const shared = {
    className: className ? `sys-inline-edit ${className}` : "sys-inline-edit",
    "aria-label": label,
    value: text,
    placeholder,
    ref: field,
    onKeyDown: keys,
    onBlur: () => {
      commit();
      onEnd?.("blur");
    },
  };
  return multiline ? (
    <textarea
      {...shared}
      rows={Math.min(6, Math.max(2, text.split("\n").length))}
      onChange={(event) => change(event.target.value)}
    />
  ) : (
    <input {...shared} onChange={(event) => change(event.target.value)} />
  );
}
