import { useCallback, useEffect, useState } from "react";
import { loadProject, loadProjectDetail } from "../api";
import { resetDocumentSeq } from "../document/cursor";
import { fetchWhileSeqStable } from "../document/fetchWhileSeqStable";
import { mergeProjectPatch } from "../document/projectPatch";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage, isAbortError } from "../utils/apiError";

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
        // A WS snapshot or edit that lands during DETAIL retries it against
        // the current document instead of leaving its transcript unhydrated.
        const detail = await fetchWhileSeqStable(
          () => loadProjectDetail(projectPath, { signal: ac.signal }),
          { delayMs: 150, isCancelled: () => cancelled },
        );
        if (!detail) {
          return;
        }
        const prev = useDawStore.getState().project;
        if (prev) {
          useDawStore
            .getState()
            .setProject(mergeProjectPatch(prev, detail.value));
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
