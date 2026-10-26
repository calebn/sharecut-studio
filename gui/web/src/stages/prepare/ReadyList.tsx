import { useId, useState } from "react";
import type { SystemIconName } from "../../system/icons";
import { StatusList } from "../../system/StatusList";
import { StatusRow, type StatusRowState } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";

export type ReadyRowId = "add" | "transcribe" | "align" | "clean" | "suggest";

export type ReadyAction =
  | "download-model"
  | "download-aligner"
  | "try-again"
  | "hear"
  | "looks-right"
  | "undo-move"
  | "keep-fixes"
  | "replace";

export type ReadyBody =
  | {
      /** A large alignment move that needs a look. */
      kind: "align";
      text: string;
    }
  | {
      /** Re-transcribing would overwrite hand-corrected words. */
      kind: "keep-fixes";
      text: string;
    }
  | {
      /** The plain cause of a failure. */
      kind: "details";
      text: string;
    };

export type ReadyRowData = {
  id: ReadyRowId;
  state: StatusRowState;
  title: string;
  detail?: string;
  /** 0 to 1 while running. */
  progress?: number;
  /** The row's one primary action. */
  action?: { label: string; icon?: SystemIconName; run: ReadyAction };
  body?: ReadyBody;
};

export type ReadyListProps = {
  rows: readonly ReadyRowData[];
  onAction: (row: ReadyRowId, action: ReadyAction) => void;
};

/** A row that needs you comes first; the rest keep the pipeline order. */
function orderRows(rows: readonly ReadyRowData[]): ReadyRowData[] {
  return [
    ...rows.filter((row) => row.state === "needs-you"),
    ...rows.filter((row) => row.state !== "needs-you"),
  ];
}

function defaultExpanded(row: ReadyRowData): boolean {
  return row.state === "needs-you" && row.body !== undefined;
}

function BodyButtons({
  row,
  onAction,
}: {
  row: ReadyRowData;
  onAction: ReadyListProps["onAction"];
}) {
  const textId = useId();
  const body = row.body;
  if (!body) return null;
  if (body.kind === "details") {
    return <p className="sys-ready-text">{body.text}</p>;
  }
  const run = (action: ReadyAction) => () => onAction(row.id, action);
  return (
    <>
      <p id={textId} className="sys-ready-text">
        {body.text}
      </p>
      <div className="sys-ready-actions" role="group" aria-labelledby={textId}>
        {body.kind === "align" ? (
          <>
            <Button onClick={run("hear")}>
              <SystemIcon name="ear" size={14} />
              Hear it
            </Button>
            <Button onClick={run("looks-right")}>Looks right</Button>
            <Button onClick={run("undo-move")}>
              <SystemIcon name="undo-2" size={14} />
              Undo move
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={run("keep-fixes")}>
              Keep my fixes
            </Button>
            <Button variant="danger" onClick={run("replace")}>
              Replace
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The Getting ready rows: what is done, what runs, what needs you. A thin map
 * onto the Status list. A row with a body opens and closes with its own
 * button; a row that needs you starts open, and opening never moves focus.
 */
export function ReadyList({ rows, onAction }: ReadyListProps) {
  const [toggled, setToggled] = useState<Partial<Record<ReadyRowId, boolean>>>(
    {},
  );
  return (
    <StatusList label="Getting ready">
      {orderRows(rows).map((row) => {
        const expanded = toggled[row.id] ?? defaultExpanded(row);
        const action = row.action;
        return (
          <StatusRow
            key={row.id}
            state={row.state}
            title={row.title}
            detail={row.detail}
            progress={row.progress}
            action={
              action
                ? {
                    label: action.label,
                    icon: action.icon,
                    onAction: () => onAction(row.id, action.run),
                  }
                : undefined
            }
            expanded={expanded}
            onToggle={() =>
              setToggled((current) => ({ ...current, [row.id]: !expanded }))
            }
          >
            {row.body ? (
              <BodyButtons row={row} onAction={onAction} />
            ) : undefined}
          </StatusRow>
        );
      })}
    </StatusList>
  );
}
