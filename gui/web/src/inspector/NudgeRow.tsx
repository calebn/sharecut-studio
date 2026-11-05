/**
 * One value's nudge buttons: fine and coarse, minus and plus, at the
 * keyboard's steps, with hold-to-repeat and one save per run (`useNudgeRun`).
 * The inspector sheet's Scrub fields draw it beside the value they nudge, so
 * the labels, steps and permission check are one thing.
 */

import {
  NUDGE_KINDS,
  type NudgeField,
  nudgeAxis,
  nudgeKey,
} from "../edit/nudge";
import type { ProjectView } from "../types/project";
import { type useNudgeRun } from "./useNudgeRun";

function stepText(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`;
}

export function NudgeRow({
  field,
  name,
  project,
  run,
}: {
  field: NudgeField;
  /** The value's name in button labels and announcements: "Trim start". */
  name: string;
  project: ProjectView;
  run: ReturnType<typeof useNudgeRun>;
}) {
  const kind = NUDGE_KINDS[field.kind];
  const value = nudgeAxis(project, field)?.value;
  const [small, large] = kind.steps;
  const deltas = [...new Set([-large, -small, small, large])];
  const bumped = run.bump?.key === nudgeKey(field);
  const label = (delta: number) =>
    [name, Math.abs(delta), kind.unit, kind.ways[delta < 0 ? 0 : 1]]
      .filter((part) => part !== "")
      .join(" ");
  return (
    <div className="nudge-row" data-bump={bumped ? "" : undefined}>
      <div
        className="nudge-row-buttons"
        role="group"
        aria-label={`Nudge ${name.toLowerCase()}`}
      >
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            className="ui-control nudge-button"
            aria-label={label(delta)}
            disabled={
              field.kind === "envelope-level" && value === 0 && delta < 0
            }
            {...run.buttonProps(field, delta, name)}
          >
            {stepText(delta)}
          </button>
        ))}
      </div>
    </div>
  );
}
