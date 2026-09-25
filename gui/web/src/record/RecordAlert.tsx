import type { ReactNode } from "react";
import { Button } from "../ui";

/** Persistent record-room alert with an optional recovery action. */
export function RecordAlert({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="record-warn" role="alert">
      {children}{" "}
      {onAction ? (
        <Button type="button" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
