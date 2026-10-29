import { type ReactNode, useEffect, useId, useRef } from "react";
import { InlineEdit, type InlineEditEnd } from "../../system/InlineEdit";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import {
  AGENT_MARK,
  isKnown,
  markOf,
  needsInput,
  PIN_FIELDS,
} from "./feedLogic";
import type { Fact, FeedEdit, FieldKey, Pending, Resolved } from "./feedView";

export type EditControls = {
  active: FieldKey | null;
  begin: (key: FieldKey) => void;
  end: () => void;
};

/** The edit that puts a value back, offered beside the toast after the value is handed back. */
export type Undo = { message: string; edit: FeedEdit };
export type OnEdit = (edit: FeedEdit, undo?: Undo) => void;

/** The words beside a value that say where it came from. An agent's carries a glyph so it is not mistaken for a person's. */
export function Mark({ text }: { text: string }) {
  return (
    <span className="fd-mark">
      {text === AGENT_MARK ? (
        <SystemIcon name="wand-sparkles" size={12} />
      ) : null}
      {text}
    </span>
  );
}

/** A missing fact says what it needs. The readiness strip and Checks carry the button that supplies it. */
export function PendingNote({ why }: { why: string }) {
  return <span className="fd-pending">{why}</span>;
}

type FactViewProps<T> = {
  fact: Fact<T>;
  children: (value: T, source: Resolved) => ReactNode;
  pending?: (source: Pending) => ReactNode;
};

/** Every fact is either known or says what it is waiting for. This is the one place that branches. */
export function FactView<T>({ fact, children, pending }: FactViewProps<T>) {
  if (isKnown(fact)) return children(fact.value, fact.source);
  return pending ? pending(fact.source) : <PendingNote why={fact.source.why} />;
}

type Props = {
  field: FieldKey;
  fact: Fact<string>;
  edit: EditControls;
  onEdit: OnEdit;
};

/**
 * A text fact read as text. A click edits it in place: Enter or leaving the
 * field commits, Escape puts the old value back, and emptying it hands the
 * value back to the listing. Handing a person's own text back offers Undo.
 */
export function FeedValue({ field, fact, edit, onEdit }: Props) {
  const spec = PIN_FIELDS[field];
  const row = useRef<HTMLDivElement>(null);
  const restore = useRef(false);
  const hint = useId();
  const editing = edit.active === field;
  useEffect(() => {
    if (editing || !restore.current) return;
    restore.current = false;
    row.current?.querySelector<HTMLElement>(".fd-value")?.focus();
  }, [editing]);
  const end = (how: InlineEditEnd) => {
    restore.current = how !== "blur";
    edit.end();
  };
  const own =
    isKnown(fact) && fact.source.kind === "pinned" ? fact.value : null;
  const handBack = () =>
    onEdit(
      { op: "unset", key: field },
      own === null
        ? undefined
        : {
            message:
              spec.reset === "Use auto"
                ? `Your ${spec.label} is back to auto.`
                : `Cleared the ${spec.label}.`,
            edit: { op: "set", key: field, value: own },
          },
    );
  const commit = (text: string) => {
    if (text.trim() === "") handBack();
    else onEdit({ op: "set", key: field, value: text });
  };
  if (editing) {
    return (
      <div className="fd-editing" ref={row} data-field={field}>
        <InlineEdit
          focusOnMount
          describedBy={hint}
          className="fd-input"
          label={`Edit ${spec.label}`}
          value={fact.value ?? ""}
          multiline={spec.multiline}
          onCommit={commit}
          onEnd={end}
        />
        <div className="fd-editing-actions">
          <span id={hint} className="fd-hint">
            Enter to save, Esc to cancel
          </span>
          {own === null ? null : (
            <Button
              variant="link"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                handBack();
                restore.current = true;
                edit.end();
              }}
            >
              {spec.reset}
            </Button>
          )}
          <Button
            className="fd-done"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              row.current
                ?.querySelector<HTMLElement>(".sys-inline-edit")
                ?.blur();
              restore.current = true;
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="fd-value-row" ref={row} data-field={field}>
      <FactView
        fact={fact}
        pending={({ why, fix }) =>
          fix && needsInput(fix) === field ? (
            <button
              type="button"
              className="fd-value fd-value--empty"
              onClick={() => edit.begin(field)}
            >
              {why}
            </button>
          ) : (
            <PendingNote why={why} />
          )
        }
      >
        {(value, source) => {
          const mark = markOf(source);
          return (
            <>
              <button
                type="button"
                className="fd-value"
                title={`Edit ${spec.label}`}
                onClick={() => edit.begin(field)}
              >
                {value}
              </button>
              {mark ? <Mark text={mark} /> : null}
            </>
          );
        }}
      </FactView>
    </div>
  );
}
