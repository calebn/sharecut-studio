import { useDawStore } from "../../../state/dawStore";
import { transcribeProgress } from "../../../state/jobMedia";
import type { ScriptStatus } from "../../../system/scriptPieces";

/** The Script's state from the store; the host adds Out of date from its `status` prop. */
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
