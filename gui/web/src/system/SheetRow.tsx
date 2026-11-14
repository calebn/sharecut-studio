import type { ReactNode } from "react";
import { Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import type { JoinRow, JoinRowAction } from "./joinSheetModel";
import { StatusRow } from "./StatusRow";

/** One row: the status line, then its controls on the row's left edge. */
export function SheetRow({
  row,
  onAction,
  children,
}: {
  row: Omit<JoinRow, "key"> & { key?: JoinRow["key"] };
  onAction?: (kind: JoinRowAction["kind"]) => void;
  children?: ReactNode;
}) {
  const { action } = row;
  return (
    <div className="sys-join-row" data-step={row.key} tabIndex={-1}>
      <StatusRow
        state={row.state}
        title={row.title}
        detail={row.detail}
        progress={row.progress}
        barLabel={row.progress === undefined ? undefined : row.title}
      />
      {action || children ? (
        <div className="sys-join-control">
          {action ? (
            <Button
              aria-label={action.name}
              aria-busy={action.busy || undefined}
              aria-disabled={action.busy || undefined}
              title={action.busy ? BUSY_REASON : undefined}
              onClick={action.busy ? undefined : () => onAction?.(action.kind)}
            >
              {action.label}
            </Button>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
