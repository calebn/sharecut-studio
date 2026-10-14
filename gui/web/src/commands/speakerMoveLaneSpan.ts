import { moveSpeakerLaneSpan } from "../api/speakerMoveLaneSpan";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { resolveSelectionRange } from "../edit/rangeSelection";
import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import {
  siblingSplitLanes,
  speakerLaneMoveTarget,
} from "../utils/speakerSplit";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

export async function runMoveSpeakerLaneSpan(
  toLaneId: string,
): Promise<ExecuteResult> {
  const state = useDawStore.getState();
  if (!canManageProjects(state.projectPath)) {
    return {
      status: "disabled",
      reason: "Only the host can move speaker-lane attribution",
    };
  }
  const resolved = state.project
    ? resolveSelectionRange(state.project, state.selection)
    : { targets: [], reason: "Open a project" };
  const target = resolved.targets.length === 1 ? resolved.targets[0]! : null;
  const move = speakerLaneMoveTarget(state.project, target);
  if (!move || !state.projectPath || state.rangeBusy) {
    return {
      status: "disabled",
      reason:
        resolved.reason ??
        "Select a range on one speaker-split lane to move it",
    };
  }
  const sibling = siblingSplitLanes(
    state.project!.tracks,
    move.fromLaneId,
  ).find((track) => track.id === toLaneId);
  if (!sibling) {
    return { status: "disabled", reason: "Choose a lane in the same split" };
  }
  state.setRangeBusy(true);
  const epoch = state.projectEpoch;
  try {
    const result = await moveSpeakerLaneSpan(state.projectPath, {
      fromLane: move.fromLaneId,
      toLane: toLaneId,
      timelineStart: move.interval.start,
      timelineEnd: move.interval.end,
    });
    if (useDawStore.getState().projectEpoch !== epoch) return { status: "ok" };
    await refreshDocumentProject(state.projectPath);
    const label = sibling.label || sibling.id;
    useDawStore
      .getState()
      .announceStatus(`Moved range to ${label}. Use Undo to restore it.`, {
        undo: result.history_head_id,
      });
    return { status: "ok" };
  } catch (error) {
    const reason = errorMessage(error);
    if (useDawStore.getState().projectEpoch === epoch)
      useDawStore.getState().announceStatus(reason);
    return { status: "disabled", reason };
  } finally {
    if (useDawStore.getState().projectEpoch === epoch)
      useDawStore.getState().setRangeBusy(false);
  }
}

export function registerSpeakerMoveLaneSpanCommands(): void {
  registerCommand("range.moveSpeakerLane", (args) => {
    const toLaneId =
      typeof args.toLaneId === "string" && args.toLaneId ? args.toLaneId : null;
    if (!toLaneId) {
      return {
        status: "disabled",
        reason: "Choose a lane to move the range to",
      };
    }
    return runMoveSpeakerLaneSpan(toLaneId);
  });
}
