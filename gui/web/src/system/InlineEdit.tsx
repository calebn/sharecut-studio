import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { BUSY_REASON } from "../ui/disabledReason";

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
  draftConflict?: { hint: string; discardLabel: string };
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
  draftConflict,
}: Props) {
  const lastSent = useRef<string | null>(null);
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [draft, setDraft] = useState<"edited" | "conflict" | null>(null);
  const conflictId = useId();
  const next = trim ? text.trim() : text;
  const conflict = draft === "conflict";
  if (value !== seen) {
    setSeen(value);
    if (draft === null || next === value) {
      setText(value);
      if (draft !== null) setDraft(null);
    } else if (!conflict) {
      setDraft("conflict");
    }
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
    if (draft === "edited") setDraft(null);
    if (next === value) {
      setText(value);
      return;
    }
    if (next !== text) setText(next);
    lastSent.current = next;
    if (onCommit(next) === false) setText(value);
  };
  const leave = useEffectEvent(() => {
    if (!ended.current && !conflict) commit();
  });
  useEffect(() => {
    if (!commitOnUnmount) return;
    return () => leave();
  }, [commitOnUnmount]);
  const change = (next: string) => {
    ended.current = false;
    if (draftConflict) {
      const edited = trim ? next.trim() : next;
      setDraft(edited === value ? null : (draft ?? "edited"));
    }
    setText(next);
  };
  const discard = () => {
    ended.current = true;
    setText(value);
    if (draft !== null) setDraft(null);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (readOnly) return;
    if (event.key === "Escape") {
      if (text !== value) event.preventDefault();
      discard();
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
    "aria-describedby": conflict
      ? [describedBy, conflictId].filter(Boolean).join(" ")
      : describedBy,
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
      if (ended.current || conflict) return;
      if (readOnly) {
        if (text !== lastSent.current) {
          setText(value);
          if (draft !== null) setDraft(null);
        }
        return;
      }
      commit();
      onEnd?.("blur");
    },
  };
  const editor = multiline ? (
    <textarea
      {...shared}
      rows={Math.min(6, Math.max(2, text.split("\n").length))}
      onChange={(event) => change(event.target.value)}
    />
  ) : (
    <input {...shared} onChange={(event) => change(event.target.value)} />
  );
  return draftConflict ? (
    <>
      {editor}
      <p id={conflictId} className="sys-inline-edit-conflict" role="status">
        {conflict ? draftConflict.hint : null}
      </p>
      {conflict && (
        <Button
          disabledReason={readOnly ? BUSY_REASON : undefined}
          onClick={() => {
            discard();
            field.current?.focus();
          }}
        >
          {draftConflict.discardLabel}
        </Button>
      )}
    </>
  ) : (
    editor
  );
}
