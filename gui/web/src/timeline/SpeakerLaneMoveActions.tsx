import { executePointerCommand } from "../commands/pointer";
import { rangeIsCurrent, resolveSelectionRange } from "../edit/rangeSelection";
import { canManageProjects } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import {
  siblingSplitLanes,
  speakerLaneMoveTarget,
} from "../utils/speakerSplit";

export function SpeakerLaneMoveActions() {
  const state = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    selection: s.selection,
    rangeBusy: s.rangeBusy,
    joinMutationInFlight: s.joinMutationInFlight,
  }));
  const { project, projectPath, selection, rangeBusy, joinMutationInFlight } =
    state;
  const resolution = project
    ? resolveSelectionRange(project, selection)
    : { targets: [], reason: null };
  const target =
    resolution.targets.length === 1 ? resolution.targets[0]! : null;
  const move = speakerLaneMoveTarget(project, target);
  if (!move || !project) return null;
  const siblings = siblingSplitLanes(project.tracks, move.fromLaneId);
  if (!siblings.length) return null;
  const host = canManageProjects(projectPath);
  const stale =
    target && !rangeIsCurrent(project, target)
      ? "Selected audio changed. Select the range again."
      : null;
  return (
    <>
      {siblings.map((lane) => {
        const label = lane.label || lane.id;
        const reason = stale
          ? stale
          : !host
            ? "Only the host can move a reply between speaker tracks"
            : rangeBusy || joinMutationInFlight
              ? BUSY_REASON
              : null;
        return (
          <Button
            key={lane.id}
            type="button"
            className="ui-control--compact"
            disabledReason={reason ?? undefined}
            onClick={() =>
              void executePointerCommand("range.moveSpeakerLane", {
                toLaneId: lane.id,
              })
            }
          >
            Move to {label}
          </Button>
        );
      })}
    </>
  );
}
