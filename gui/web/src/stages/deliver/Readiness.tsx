import { useId } from "react";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import type { StageId } from "../../system/verbs";
import {
  type ReadinessFix,
  type ReadinessRow,
  readinessSummary,
} from "./deliverLogic";

type Props = {
  rows: readonly ReadinessRow[];
  state?: "ready" | "loading" | "error";
  /** Opens the stage with the item selected. */
  onFix: (stage: StageId, target?: string) => void;
  onRetry?: () => void;
};

/** What is left before the episode is done. Nothing here blocks Export. */
export function Readiness({ rows, state = "ready", onFix, onRetry }: Props) {
  const id = useId();
  if (state !== "ready") {
    return (
      <section className="dv-readiness" aria-label="Readiness">
        {state === "loading" ? (
          <Skeleton layout="list" rows={4} />
        ) : (
          <StatusRow
            state="failed"
            title="Could not check the episode"
            detail="You can still export."
            action={
              onRetry ? { label: "Try again", onAction: onRetry } : undefined
            }
          />
        )}
      </section>
    );
  }
  const fix = (row: ReadinessFix | undefined, target?: string) =>
    row
      ? { label: row.label, onAction: () => onFix(row.stage, target) }
      : undefined;
  return (
    <section className="dv-readiness" aria-labelledby={id}>
      <h2 id={id} className="dv-section-title" aria-live="polite">
        {readinessSummary(rows)}
      </h2>
      <ul className="dv-readiness-list">
        {rows.map((row) => (
          <li key={row.id}>
            <StatusRow
              state={row.state}
              title={row.title}
              detail={row.detail}
              action={fix(row.fix, row.fix?.target)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
