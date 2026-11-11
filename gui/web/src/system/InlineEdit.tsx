import { useEffect, useEffectEvent, useRef, useState } from "react";

export type InlineEditEnd = "enter" | "escape" | "blur";

type Props = {
  /** Accessible name; the field shows no visible label. */
  label: string;
  value: string;
  /** Called with a text that differs from `value`, on Enter and on blur. A parent that ignores it sees the same text sent again on the next end. Returning `false` refuses the text and the field shows `value` again. */
  onCommit: (value: string) => void | false;
  /** Trims the text on commit and shows the trimmed text, so a trailing space does not stay in a field that saved nothing. */
  trim?: boolean;
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
  readOnly?: boolean;
  className?: string;
};

export function InlineEdit({
  label,
  value,
  onCommit,
  onEnd,
  trim = false,
  multiline = false,
  focusOnMount = false,
  commitOnUnmount = false,
  describedBy,
  placeholder,
  maxLength,
  readOnly = false,
  className,
}: Props) {
  const lastSent = useRef<string | null>(null);
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
    lastSent.current = null;
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
    if (readOnly || text === value) return;
    const next = trim ? text.trim() : text;
    if (next === value) {
      setText(value);
      return;
    }
    if (next !== text) setText(next);
    lastSent.current = next;
    if (onCommit(next) === false) setText(value);
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
    if (readOnly) return;
    if (event.key === "Escape") {
      if (text !== value) event.preventDefault();
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
    readOnly,
    "aria-busy": readOnly || undefined,
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      field.current = el;
    },
    onKeyDown: keys,
    onFocus: () => {
      ended.current = false;
    },
    onBlur: () => {
      if (ended.current) return;
      if (readOnly) {
        if (text !== lastSent.current) setText(value);
        return;
      }
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
