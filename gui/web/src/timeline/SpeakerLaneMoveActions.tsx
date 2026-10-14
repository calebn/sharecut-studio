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
  }));
  const { project, projectPath, selection, rangeBusy } = state;
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
    target && project && !rangeIsCurrent(project, target)
      ? "Selected audio changed. Select the range again."
      : null;
  return (
    <div className="speaker-lane-move-actions">
      {siblings.map((lane) => {
        const label = lane.label || lane.id;
        const reason = stale
          ? stale
          : !host
            ? "Only the host can move speaker-lane attribution"
            : rangeBusy
              ? BUSY_REASON
              : null;
        return (
          <Button
            key={lane.id}
            type="button"
            className="ui-control"
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
    </div>
  );
}
