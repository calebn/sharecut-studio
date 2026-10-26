import { useId } from "react";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import type { StageId } from "../../system/verbs";
import { type ReadinessRow, readinessSummary } from "./deliverLogic";

type Props = {
  rows: readonly ReadinessRow[];
  state?: "ready" | "loading";
  /** Opens the stage with the item selected. */
  onFix: (stage: StageId, target?: string) => void;
};

/** Nothing here blocks Export. */
export function Readiness({ rows, state = "ready", onFix }: Props) {
  const id = useId();
  if (state === "loading") {
    return (
      <section className="dv-readiness" aria-label="Readiness">
        <Skeleton layout="list" rows={4} />
      </section>
    );
  }
  return (
    <section className="dv-readiness" aria-labelledby={id}>
      <h2 id={id} className="dv-section-title" aria-live="polite">
        {readinessSummary(rows)}
      </h2>
      <ul className="dv-readiness-list">
        {rows.map((row) => {
          const fix = row.fix;
          return (
            <li key={row.id}>
              <StatusRow
                state={row.state}
                title={row.title}
                detail={row.detail}
                action={
                  fix
                    ? {
                        label: fix.label,
                        onAction: () => onFix(fix.stage, fix.target),
                      }
                    : undefined
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
