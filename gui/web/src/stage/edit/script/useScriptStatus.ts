import { useDawStore } from "../../../state/dawStore";
import { isTranscribing } from "../../../state/jobMedia";
import type { ScriptStatus } from "../../../system/scriptPieces";

/** Whether the open project's transcript words are still loading. */
export const selectTranscriptLoading = (
  s: ReturnType<typeof useDawStore.getState>,
) => s.project?.meta.hydration?.transcript_words === false;

/** The Script's state from the store; the host adds Out of date from its `status` prop. */
export function useScriptStatus(
  hasWords: boolean,
  onTranscribe: (() => void) | undefined,
): Exclude<ScriptStatus, { kind: "outOfDate" }> {
  const loading = useDawStore(selectTranscriptLoading);
  const transcribing = useDawStore((s) =>
    isTranscribing(s.pipelineJob, s.projectPath),
  );
  if (loading) return { kind: "loading" };
  if (transcribing) return { kind: "transcribing" };
  return hasWords ? { kind: "ready" } : { kind: "empty", onTranscribe };
}
