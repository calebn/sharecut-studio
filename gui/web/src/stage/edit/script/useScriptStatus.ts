import { useDawStore } from "../../../state/dawStore";
import { transcribeProgress } from "../../../state/jobMedia";
import type { ScriptStatus } from "../../../system/scriptPieces";

/**
 * The Script's state from the store: words still loading, a run that is
 * still making the transcript, words ready, or none yet. Out of date has no
 * store source in Edit, so the host takes it from its `status` prop.
 */
export function useScriptStatus(
  hasWords: boolean,
  onTranscribe: (() => void) | undefined,
): Exclude<ScriptStatus, { kind: "outOfDate" }> {
  const loading = useDawStore(
    (s) => s.project?.meta.hydration?.transcript_words === false,
  );
  const progress = useDawStore((s) =>
    transcribeProgress(s.pipelineJob, s.projectPath, hasWords),
  );
  if (loading) return { kind: "loading" };
  if (progress !== null) return { kind: "transcribing", progress };
  return hasWords ? { kind: "ready" } : { kind: "empty", onTranscribe };
}
