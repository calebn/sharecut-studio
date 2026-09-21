import { useCallback, useEffect, useState } from "react";
import { loadProject, loadProjectDetail } from "../api";
import { currentDocumentSeq, resetDocumentSeq } from "../document/cursor";
import { mergeProjectPatch } from "../document/projectPatch";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

/**
 * Fetch shell ProjectView then detail hydrate. Does not call store.hydrate()
 * (that clears waveform caches).
 */
export function useProjectBootstrap(
  projectPath: string,
  enabled = true,
): {
  error: string | null;
  retry: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setRetryToken((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    resetDocumentSeq();
    // A new project document means new audio: drop any transport error
    // carried over from the previous project.
    useDawStore.getState().setAudioError(null);
    setError(null);
    void (async () => {
      try {
        const shell = await loadProject(projectPath, { signal: ac.signal });
        if (cancelled) {
          return;
        }
        useDawStore.getState().setProject(shell);
        if (isShareProjectKey(projectPath)) {
          return;
        }
        const seqAtStart = currentDocumentSeq();
        const detail = await loadProjectDetail(projectPath, {
          signal: ac.signal,
        });
        if (cancelled || currentDocumentSeq() !== seqAtStart) {
          return;
        }
        const prev = useDawStore.getState().project;
        if (prev) {
          useDawStore.getState().setProject(mergeProjectPatch(prev, detail));
        }
      } catch (e: unknown) {
        if (!cancelled && !isAbortError(e)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [enabled, projectPath, retryToken]);

  return { error, retry };
}
