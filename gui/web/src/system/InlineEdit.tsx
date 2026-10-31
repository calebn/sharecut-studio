import { useEffect, useEffectEvent, useRef, useState } from "react";

export type InlineEditEnd = "enter" | "escape" | "blur";

type Props = {
  /** Accessible name; the field shows no visible label. */
  label: string;
  value: string;
  /** Called with a text that differs from `value`, on Enter and on blur. A parent that ignores it sees the same text sent again on the next end. */
  onCommit: (value: string) => void;
  /** After the field finishes by Enter, Escape or blur. A blur that follows Enter or Escape is not reported. */
  onEnd?: (how: InlineEditEnd) => void;
  /** Enter commits; Shift+Enter breaks the line. */
  multiline?: boolean;
  focusOnMount?: boolean;
  /** Sends text typed but not yet committed when the field unmounts, unless Enter or Escape already ended it. For a field whose stage can close under it. */
  commitOnUnmount?: boolean;
  /** The id of text that says how to finish, such as a key hint. */
  describedBy?: string;
  placeholder?: string;
  /** The longest text the field takes. */
  maxLength?: number;
  className?: string;
};

/**
 * A text value edited where it is read. It looks like text until hovered or
 * focused. Enter and blur commit a text that differs from `value`, and Escape
 * puts `value` back.
 */
export function InlineEdit({
  label,
  value,
  onCommit,
  onEnd,
  multiline = false,
  focusOnMount = false,
  commitOnUnmount = false,
  describedBy,
  placeholder,
  maxLength,
  className,
}: Props) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const ended = useRef(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = field.current;
    if (!focusOnMount || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusOnMount]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  const leave = useEffectEvent(() => {
    if (!ended.current) commit();
  });
  useEffect(() => {
    if (!commitOnUnmount) return;
    return () => leave();
  }, [commitOnUnmount]);
  const change = (next: string) => {
    ended.current = false;
    setText(next);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      ended.current = true;
      setText(value);
      onEnd?.("escape");
    } else if (
      event.key === "Enter" &&
      !(multiline && event.shiftKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      ended.current = true;
      commit();
      onEnd?.("enter");
    }
  };
  const shared = {
    className: className ? `sys-inline-edit ${className}` : "sys-inline-edit",
    "aria-label": label,
    "aria-describedby": describedBy,
    value: text,
    placeholder,
    maxLength,
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      field.current = el;
    },
    onKeyDown: keys,
    onFocus: () => {
      ended.current = false;
    },
    onBlur: () => {
      if (ended.current) return;
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
