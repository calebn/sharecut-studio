import { useCallback, useEffect, useState } from "react";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
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
    if (!enabled || !projectPath) return;
    const scope = activateDocumentScope(projectPath);
    return () => {
      if (isCurrentDocumentScope(scope)) resetDocumentAuthority();
    };
  }, [enabled, projectPath]);

  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const scope = activateDocumentScope(projectPath);
    setError(null);
    void (async () => {
      try {
        const shell = await loadDocumentState(projectPath, "shell", ac.signal);
        if (cancelled || !isCurrentDocumentScope(scope)) return;
        applyDocumentSnapshot(shell, { scope });
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
