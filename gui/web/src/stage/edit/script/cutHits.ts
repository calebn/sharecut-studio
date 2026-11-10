import { replyHistoryHead } from "../../../api";
import { submitRangeEdit } from "../../../commands/submitRangeEdit";
import {
  loadCommandQueue,
  loadHostCommandQueue,
} from "../../../services/offlineQueue/offlineStore";
import { isShareProjectKey, shareTokenFromKey } from "../../../shareMode";
import { useDawStore } from "../../../state/dawStore";
import type { FindHit } from "../../../system/scriptPieces";
import { ApiError } from "../../../utils/apiError";
import { cutAllMessage, cutKey, matchCutOf } from "./findCut";
import type { ScriptModel } from "./scriptModel";

function cutAllFailure(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "cut_scope_changed") {
    if (/need audio review/.test(error.message))
      return new Error(
        "Some of these matches are held for an audio check. Nothing was cut.",
      );
    if (/needs another review/.test(error.message))
      return new Error(
        "Nothing was cut. The host has to review this edit first.",
      );
    return new Error("Nothing was cut. The edit was not applied.");
  }
  if (error.code === "overlapping_targets")
    return new Error(
      "Some matches overlap on one track, so nothing was cut. Try a narrower search or cut them in the timeline.",
    );
  return error;
}

function wasProposed(result: Record<string, unknown>): boolean {
  const command = result.command as
    | { payload?: { result?: { proposed?: unknown } } }
    | undefined;
  return command?.payload?.result?.proposed === true;
}

async function queuedIds(projectPath: string): Promise<Set<string>> {
  const rows = isShareProjectKey(projectPath)
    ? await loadCommandQueue(shareTokenFromKey(projectPath)!)
    : await loadHostCommandQueue(projectPath);
  return new Set(rows.map((row) => row.command_id));
}

const queued = new Map<string, { epoch: number; commandId: string }>();

export function resetQueuedCutsForTests(): void {
  queued.clear();
}

/**
 * Cuts every hit in one undo step. A cut that was queued offline is
 * remembered per project and epoch, so a second press of Cut all, from the
 * Find bar or a toast, does not queue it twice.
 */
export async function cutHits(
  model: ScriptModel,
  hits: readonly FindHit[],
): Promise<void> {
  const {
    project,
    projectPath,
    rangeBusy,
    joinMutationInFlight,
    announceStatus,
    projectEpoch: epoch,
    setRangeBusy,
  } = useDawStore.getState();
  if (!project) throw new Error("Open a project");
  if (rangeBusy || joinMutationInFlight)
    throw new Error("Wait for the current edit to finish.");
  const plan = matchCutOf(project, model, hits);
  if (plan.targets.length === 0)
    throw new Error("No audible words in these matches.");
  const key = `${projectPath}\0${cutKey(plan.targets)}`;
  const offline = navigator.onLine === false;
  setRangeBusy(true);
  try {
    for (const [other, entry] of queued)
      if (entry.epoch !== epoch) queued.delete(other);
    const mine = [...queued].filter(([other]) =>
      other.startsWith(`${projectPath}\0`),
    );
    if (mine.length > 0) {
      const ids = await queuedIds(projectPath).catch(() => null);
      if (useDawStore.getState().projectEpoch !== epoch) return;
      if (!ids) throw new Error("Nothing was cut. Try again.");
      for (const [other, entry] of mine)
        if (!ids.has(entry.commandId)) queued.delete(other);
      if (queued.has(key))
        throw new Error("Cut all is already queued. Wait for it to send.");
    }
    const result = await submitRangeEdit("cut", plan.targets).catch(
      (error: unknown) => {
        throw cutAllFailure(error);
      },
    );
    if (useDawStore.getState().projectEpoch !== epoch) return;
    if (result.queued === true) {
      queued.set(key, { epoch, commandId: String(result.command_id) });
      announceStatus(
        isShareProjectKey(projectPath) && offline
          ? "Cut all queued as a suggestion for host review. Reconnect to send it."
          : "Cut all queued. Still sending.",
      );
      return;
    }
    if (wasProposed(result)) {
      announceStatus("Cut all was suggested for review. Nothing was cut yet.");
      return;
    }
    if (result.type !== "Applied") {
      announceStatus("Nothing was cut. The edit was not applied.", {
        tone: "error",
      });
      return;
    }
    announceStatus(cutAllMessage(plan.cut, plan.skipped), {
      undo: replyHistoryHead(result),
    });
  } finally {
    if (useDawStore.getState().projectEpoch === epoch) setRangeBusy(false);
  }
}
