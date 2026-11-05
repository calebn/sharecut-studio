/**
 * One value's nudge buttons: fine and coarse, minus and plus, at the
 * keyboard's steps, with hold-to-repeat and one save per run (`useNudgeRun`).
 * The phone peek strip and the inspector sheet's Scrub fields both draw it, so
 * the labels, steps and permission check are one thing.
 */

import { NUDGE_KINDS, nudgeAxis, nudgeKey } from "../edit/nudge";
import type { ProjectView } from "../types/project";
import type { PeekNudgeRow } from "./peekTarget";
import { type NudgeBump, type useNudgeRun } from "./useNudgeRun";

function stepText(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`;
}

export function NudgeRow({
  row,
  project,
  run,
}: {
  row: PeekNudgeRow;
  project: ProjectView;
  run: ReturnType<typeof useNudgeRun>;
}) {
  const kind = NUDGE_KINDS[row.field.kind];
  const value = nudgeAxis(project, row.field)?.value;
  const [small, large] = kind.steps;
  const deltas = [...new Set([-large, -small, small, large])];
  const bump: NudgeBump | null =
    run.bump?.key === nudgeKey(row.field) ? run.bump : null;
  const label = (delta: number) =>
    [row.name, Math.abs(delta), kind.unit, kind.ways[delta < 0 ? 0 : 1]]
      .filter((part) => part !== "")
      .join(" ");
  return (
    <div className="nudge-row" data-bump={bump ? "" : undefined}>
      {row.label ? (
        <span className="nudge-row-reading">
          <span className="nudge-row-label">{row.label}</span>
          {value != null ? (
            <output key={bump?.n} className="nudge-row-value">
              {kind.format(value)}
            </output>
          ) : null}
        </span>
      ) : null}
      <div
        className="nudge-row-buttons"
        role="group"
        aria-label={`Nudge ${row.name.toLowerCase()}`}
      >
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            className="ui-control nudge-button"
            aria-label={label(delta)}
            disabled={
              row.field.kind === "envelope-level" && value === 0 && delta < 0
            }
            {...run.buttonProps(row.field, delta, row.name)}
          >
            {stepText(delta)}
          </button>
        ))}
      </div>
    </div>
  );
}
