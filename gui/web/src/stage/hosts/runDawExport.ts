import { type DawFormat, startDawSession } from "../../api/dawExport";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import { bounceResultAction, fileIdsOf } from "./bounceResultAction";
import { hostFileAccess } from "./useDeliverFiles";

export async function exportDawSession(projectPath: string, format: DawFormat) {
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
