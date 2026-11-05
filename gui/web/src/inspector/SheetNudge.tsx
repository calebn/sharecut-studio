/**
 * The nudge buttons beside a sheet Scrub field: the same fine and
 * coarse minus and plus the phone strip draws, for the field's own value.
 * Nothing draws for a viewer who may not change the value, or a value the
 * project does not have (a pending split has no edges).
 */

import { mayNudge } from "../edit/mayNudge";
import { type NudgeField, nudgeAxis } from "../edit/nudge";
import { useDaw } from "../state/useDaw";
import type { ProjectView } from "../types/project";
import { NudgeRow } from "./NudgeRow";
import { useNudgeRun } from "./useNudgeRun";

export function SheetNudge({
  field,
  name,
  hidden = false,
}: {
  field: NudgeField;
  /** The value's name in button labels and announcements: "Trim start". */
  name: string;
  /** The field beside it is read-only. */
  hidden?: boolean;
}) {
  const { project, ...access } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    shareAuthor: s.shareAuthor,
    joinMutationInFlight: s.joinMutationInFlight,
  }));
  if (
    hidden ||
    !project ||
    nudgeAxis(project, field) == null ||
    !mayNudge(access, project, field)
  )
    return null;
  return <SheetNudgeRow field={field} name={name} project={project} />;
}

/** Owns the run, so a row that stops drawing ends a held nudge with it. */
function SheetNudgeRow({
  field,
  name,
  project,
}: {
  field: NudgeField;
  name: string;
  project: ProjectView;
}) {
  const run = useNudgeRun();
  return (
    <NudgeRow row={{ field, label: null, name }} project={project} run={run} />
  );
}
