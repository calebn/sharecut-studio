import type { ReactNode } from "react";
import type { JoinRow } from "./joinSheetModel";
import { StatusRow } from "./StatusRow";

/** One row of the Join or Device sheet: its status line, its action, and the control beside it. */
export function SheetRow({
  row,
  onAction,
  children,
}: {
  row: Omit<JoinRow, "key"> & { key?: JoinRow["key"] };
  onAction?: (kind: NonNullable<JoinRow["action"]>["kind"]) => void;
  children?: ReactNode;
}) {
  const { action } = row;
  return (
    <div className="sys-join-row" data-step={row.key} tabIndex={-1}>
      <StatusRow
        state={row.state}
        title={row.title}
        detail={row.detail}
        action={
          action
            ? {
                label: action.label,
                name: action.name,
                onAction: () => onAction?.(action.kind),
              }
            : undefined
        }
      />
      {children ? <div className="sys-join-control">{children}</div> : null}
    </div>
  );
}
