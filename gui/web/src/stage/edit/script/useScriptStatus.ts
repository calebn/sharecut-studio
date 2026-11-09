import { useDawStore } from "../../../state/dawStore";
import { runIncludesTranscribe } from "../../../state/jobMedia";
import type { ScriptStatus } from "../../../system/scriptPieces";
import { isPipelineKindJob, isPipelineRunning } from "../../../utils/pipeline";
import { pipelineProgressPercent } from "../../../utils/pipelineProgress";

/**
 * The Script's state from the store: words still loading, a run that is
 * transcribing this project, words ready, or none yet. Out of date has no
 * store source in Edit, so the host takes it from its `status` prop.
 */
export function useScriptStatus(
  hasWords: boolean,
  onTranscribe: (() => void) | undefined,
): ScriptStatus {
  const loading = useDawStore(
    (s) => s.project?.meta.hydration?.transcript_words === false,
  );
  const progress = useDawStore((s) => {
    const job = s.pipelineJob;
    if (
      !job ||
      !isPipelineKindJob(job) ||
      !isPipelineRunning(job) ||
      job.project_path !== s.projectPath ||
      !runIncludesTranscribe({
        fromStep: job.from_step,
        onlyStep: job.only_step,
      })
    )
      return null;
    return (pipelineProgressPercent(job) ?? 0) / 100;
  });
  if (loading) return { kind: "loading" };
  if (progress !== null) return { kind: "transcribing", progress };
  return hasWords ? { kind: "ready" } : { kind: "empty", onTranscribe };
}
