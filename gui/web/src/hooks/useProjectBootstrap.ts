import { useCallback, useEffect, useState } from "react";
import { loadProject, loadProjectDetail } from "../api";
import { currentDocumentSeq, resetDocumentSeq } from "../document/cursor";
import { mergeProjectPatch } from "../document/projectPatch";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";

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
        while (!cancelled) {
          const seqAtStart = currentDocumentSeq();
          const detail = await loadProjectDetail(projectPath, {
            signal: ac.signal,
          });
          if (cancelled) {
            return;
          }
          if (currentDocumentSeq() !== seqAtStart) {
            // A WS snapshot or edit landed during DETAIL. Retry against the
            // current document instead of leaving its transcript unhydrated.
            await new Promise((resolve) => window.setTimeout(resolve, 150));
            continue;
          }
          const prev = useDawStore.getState().project;
          if (prev) {
            useDawStore.getState().setProject(mergeProjectPatch(prev, detail));
          }
          return;
        }
      } catch (e: unknown) {
        if (!cancelled && !isAbortError(e)) {
          setError(errorMessage(e));
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
