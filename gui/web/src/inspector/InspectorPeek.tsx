/**
 * The compact inspector's peek strip (#1051 rounds 3 and 4): what is
 * selected, its key value, and a row of four nudges at the keyboard's steps
 * for each value the user may change: a clip's fade or trim, a pending edit's
 * start and end, an envelope point's time and level. Holding a nudge repeats
 * it; the run saves once (`useNudgeRun`). Expanding the sheet shows the full
 * inspector with its fields.
 */

import { mayNudge } from "../edit/mayNudge";
import { NUDGE_KINDS, nudgeKey } from "../edit/nudge";
import { useDaw } from "../state/useDaw";
import { RippleMark } from "../ui/RippleMark";
import { NudgeRow } from "./NudgeRow";
import type { PeekTarget } from "./peekTarget";
import { useNudgeRun } from "./useNudgeRun";

export function InspectorPeek({ peek }: { peek: PeekTarget }) {
  const { project, ...access } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    shareAuthor: s.shareAuthor,
    joinMutationInFlight: s.joinMutationInFlight,
  }));
  const run = useNudgeRun();
  const rows = project
    ? peek.nudges.filter((row) => mayNudge(access, project, row.field))
    : [];
  const ripples = rows.some((row) => NUDGE_KINDS[row.field.kind].ripples);
  // Rows with labels carry their own values; a lone row shows the key value.
  const summary = !rows.some((row) => row.label);
  const bumped = run.bump != null && rows.length === 1 && !rows[0].label;
  return (
    <div className="inspector-peek">
      <p className="inspector-peek-reading">
        {peek.owner ? (
          <span className="inspector-peek-owner">{peek.owner}</span>
        ) : null}
        {ripples ? <RippleMark /> : null}
        {summary ? (
          <output
            key={bumped ? run.bump?.n : undefined}
            className="inspector-peek-value"
            data-bump={bumped ? "" : undefined}
          >
            {peek.value}
          </output>
        ) : null}
      </p>
      {project
        ? rows.map((row) => (
            <NudgeRow
              key={nudgeKey(row.field)}
              row={row}
              project={project}
              run={run}
            />
          ))
        : null}
    </div>
  );
}
