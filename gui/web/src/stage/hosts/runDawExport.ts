import { type DawFormat, startDawSession } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import type { DawState } from "../../state/types";
import { isPipelineRunning } from "../../utils/pipeline";
import { bounceResultAction, fileIdsOf } from "./bounceResultAction";
import { hostFileAccess } from "./useDeliverFiles";

export function dawStartPending(state: DawState) {
  return Array.from(state.jobResultStarts.values()).includes("daw_export");
}

export async function exportDawSession(projectPath: string, format: DawFormat) {
  const state = useDawStore.getState();
  if (
    dawStartPending(state) ||
    (state.activityJob?.kind === "daw_export" &&
      isPipelineRunning(state.activityJob))
  )
    throw new Error("A DAW export is already running.");
  const scope = projectScopedSignal(projectPath);
  try {
    const job = await runAnnouncedJob(
      () => startDawSession(projectPath, format, scope.signal),
      {
        kind: "daw_export",
        signal: scope.signal,
        failLabel: "DAW export failed.",
        summarizeResult: (done) => {
          const ids = fileIdsOf(done);
          if (ids.length !== 1) return null;
          return {
            copy: "DAW session exported.",
            action: bounceResultAction(projectPath, ids, hostFileAccess()),
          };
        },
      },
    );
    return fileIdsOf(job)[0];
  } finally {
    scope.dispose();
  }
}
