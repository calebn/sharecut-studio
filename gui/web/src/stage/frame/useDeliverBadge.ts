import { useContext } from "react";
import { isShareProjectKey } from "../../shareMode";
import { useExportedFiles } from "../../stages/deliver/useExportedFiles";
import { useDaw } from "../../state/useDaw";
import type { StageBadge } from "../../system/StageBadgeViews";
import { Flow } from "../hosts/exportFlowContext";

/**
 * The Deliver tab's badge: a check while an audio file in the export folder is
 * current, a dot once every audio file there is older than the latest edit,
 * nothing before the first export. The listing is the server's, so a failed or
 * cancelled run that left files behind still counts, and a guest never gets one.
 */
export function useDeliverBadge(): StageBadge | undefined {
  const flow = useContext(Flow);
  const { projectPath, headId, host } = useDaw((s) => ({
    projectPath: s.projectPath,
    headId: s.project?.history.head_id ?? null,
    host: s.guestMode === null && !isShareProjectKey(s.projectPath),
  }));
  const run = flow?.run;
  const settled = run
    ? `${run.kind}|${"finishedAt" in run ? run.finishedAt : ""}`
    : "";
  const { files, currentLoad } = useExportedFiles(host ? projectPath : null, {
    access: "download",
    refreshKey: `${headId}|${settled}`,
  });
  if (currentLoad !== "ready") return undefined;
  const audio = files.filter((file) => file.kind === "audio");
  if (audio.length === 0) return undefined;
  return audio.some((file) => file.current)
    ? { kind: "done" }
    : { kind: "needs-you" };
}
