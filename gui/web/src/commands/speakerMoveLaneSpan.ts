import { replyHistoryHead } from "../api/documentEdits";
import { moveSpeakerLaneSpan } from "../api/speakerMoveLaneSpan";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { rangeIsCurrent, resolveSelectionRange } from "../edit/rangeSelection";
import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import {
  siblingSplitLanes,
  speakerLaneMoveTarget,
} from "../utils/speakerSplit";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

const HOST_REASON = "Only the host can move a reply between speaker tracks";

export async function runMoveSpeakerLaneSpan(
  toLaneId: string,
): Promise<ExecuteResult> {
  const state = useDawStore.getState();
  if (!canManageProjects(state.projectPath)) {
    return { status: "disabled", reason: HOST_REASON };
  }
  const resolved = state.project
    ? resolveSelectionRange(state.project, state.selection)
    : { targets: [], reason: "Open a project" };
  const target = resolved.targets.length === 1 ? resolved.targets[0]! : null;
  const move = speakerLaneMoveTarget(state.project, target);
  const sibling =
    state.project && move
      ? siblingSplitLanes(state.project.tracks, move.fromLaneId).find(
          (track) => track.id === toLaneId,
        )
      : undefined;
  const reason = !state.project
    ? "Open a project"
    : state.rangeBusy
      ? "Range action in progress"
      : state.joinMutationInFlight
        ? "Wait for the join edit"
        : !target
          ? (resolved.reason ?? "Select a range on one speaker track")
          : !move
            ? "Select a range on one speaker track"
            : !rangeIsCurrent(state.project, target)
              ? "Selected audio changed. Select the range again."
              : !sibling
                ? "Choose a sibling speaker track"
                : null;
  if (reason || !move || !sibling || !state.projectPath) {
    return {
      status: "disabled",
      reason: reason ?? "Select a range on one speaker track",
    };
  }
  state.setRangeBusy(true);
  const epoch = state.projectEpoch;
  const selection = state.selection;
  try {
    const result = await moveSpeakerLaneSpan(state.projectPath, {
      fromLane: move.fromLaneId,
      toLane: toLaneId,
      timelineStart: move.interval.start,
      timelineEnd: move.interval.end,
    });
    const live = useDawStore.getState();
    if (live.projectEpoch !== epoch) return { status: "ok" };
    await refreshDocumentProject(state.projectPath);
    const after = useDawStore.getState();
    if (after.projectEpoch !== epoch) return { status: "ok" };
    if (after.selection === selection) after.setSelection(null);
    const label = sibling.label || sibling.id;
    after.announceStatus(
      `Moved the range to ${label}. Use Undo to restore it.`,
      {
        undo: replyHistoryHead({ history_head_id: result.history_head_id }),
      },
    );
    return { status: "ok" };
  } catch (error) {
    const message = errorMessage(error);
    if (useDawStore.getState().projectEpoch === epoch) {
      useDawStore.getState().announceStatus(message, { tone: "error" });
    }
    return { status: "disabled", reason: message };
  } finally {
    if (useDawStore.getState().projectEpoch === epoch) {
      useDawStore.getState().setRangeBusy(false);
    }
  }
}

export function registerSpeakerMoveLaneSpanCommands(): void {
  registerCommand("range.moveSpeakerLane", (args) => {
    const toLaneId =
      typeof args.toLaneId === "string" && args.toLaneId ? args.toLaneId : null;
    if (!toLaneId) {
      return {
        status: "disabled",
        reason: "Choose a speaker track to move the range to",
      };
    }
    return runMoveSpeakerLaneSpan(toLaneId);
  });
}
