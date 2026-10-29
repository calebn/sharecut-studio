import { useEffect, useRef } from "react";
import { InlineEdit, type InlineEditEnd } from "../../system/InlineEdit";
import { Button } from "../../ui";
import { isKnown, markOf, PIN_FIELDS } from "./feedLogic";
import type { Fact, FeedEdit, Fix, PinKey } from "./feedView";

export type EditControls = {
  active: PinKey | null;
  begin: (key: PinKey) => void;
  end: () => void;
};

/** A missing fact says what it needs and carries the button that supplies it. */
export function PendingNote({
  why,
  fix,
  onFix,
}: {
  why: string;
  fix: Fix | null;
  onFix: (fix: Fix) => void;
}) {
  return (
    <span className="fd-pending">
      <span>{why}</span>
      {fix ? <Button onClick={() => onFix(fix)}>{fix.label}</Button> : null}
    </span>
  );
}

type Props = {
  field: PinKey;
  fact: Fact<string>;
  edit: EditControls;
  onEdit: (edit: FeedEdit) => void;
  onFix: (fix: Fix) => void;
};

/**
 * A text fact read as text. A click edits it in place: Enter or leaving the
 * field commits, Escape puts the old value back, and emptying it hands the
 * value back to the listing.
 */
export function FeedValue({ field, fact, edit, onEdit, onFix }: Props) {
  const spec = PIN_FIELDS[field];
  const row = useRef<HTMLDivElement>(null);
  const restore = useRef(false);
  const reset = useRef(false);
  const editing = edit.active === field;
  useEffect(() => {
    if (editing) reset.current = false;
    else if (restore.current) {
      restore.current = false;
      row.current?.querySelector("button")?.focus();
    }
  }, [editing]);
  const end = (how: InlineEditEnd) => {
    restore.current = how !== "blur";
    edit.end();
  };
  const commit = (text: string) => {
    if (reset.current) return;
    onEdit(
      text.trim() === ""
        ? { op: "unset", key: field }
        : { op: "set", key: field, value: text },
    );
  };
  if (editing) {
    const pinned = isKnown(fact) && fact.source.kind === "pinned";
    return (
      <div className="fd-editing" ref={row}>
        <InlineEdit
          autoFocus
          className="fd-input"
          label={`Edit ${spec.label}`}
          value={fact.value ?? ""}
          multiline={spec.multiline}
          onCommit={commit}
          onEnd={end}
        />
        {pinned ? (
          <Button
            variant="link"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              reset.current = true;
              onEdit({ op: "unset", key: field });
              restore.current = true;
              edit.end();
            }}
          >
            {spec.reset}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!isKnown(fact)) {
    return (
      <div ref={row}>
        <PendingNote
          why={fact.source.why}
          fix={fact.source.fix}
          onFix={onFix}
        />
      </div>
    );
  }
  const mark = markOf(fact.source);
  return (
    <div className="fd-value-row" ref={row}>
      <button
        type="button"
        className="fd-value"
        title={`Edit ${spec.label}`}
        onClick={() => edit.begin(field)}
      >
        {fact.value}
      </button>
      {mark ? <span className="fd-mark">{mark}</span> : null}
    </div>
  );
}
