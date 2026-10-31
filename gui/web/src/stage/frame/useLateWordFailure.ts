import { useEffect } from "react";
import { useDawStore } from "../../state/dawStore";

/**
 * A word action that failed after its editor or the Inspector had closed
 * (Suppress, Ignore, the timing sheet) leaves its message in the store. The
 * frame says it once, as an error toast, and clears it, whichever stage is open.
 */
export function useLateWordFailure(): void {
  const failure = useDawStore((s) => s.transcriptInlineEditFailure);
  const projectPath = useDawStore((s) => s.projectPath);
  useEffect(() => {
    if (!failure) return;
    const store = useDawStore.getState();
    store.setTranscriptInlineEditFailure(null);
    if (failure.projectPath !== projectPath) return;
    store.announceStatus(failure.message, { tone: "error" });
  }, [failure, projectPath]);
}
