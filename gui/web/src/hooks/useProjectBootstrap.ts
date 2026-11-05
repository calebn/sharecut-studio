import { useCallback, useEffect, useState } from "react";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import {
  errorMessage,
  isAbortError,
  isServerTimeoutError,
} from "../utils/apiError";

const WARM_SHELL_RETRY_DELAY_MS = 3_000;
const WARM_SHELL_MAX_ATTEMPTS = 10;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(), ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
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
  /** Try again was pressed and the load has not settled yet. */
  retrying: boolean;
  retry: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setRetrying(true);
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
    const hadProjectAtStart = useDawStore.getState().project != null;
    setError(null);
    void (async () => {
      let warmAttempts = 0;
      while (!cancelled && isCurrentDocumentScope(scope)) {
        try {
          const shell = await loadDocumentState(
            projectPath,
            "shell",
            ac.signal,
          );
          if (cancelled || !isCurrentDocumentScope(scope)) return;
          applyDocumentSnapshot(shell, { scope });
          setRetrying(false);
          return;
        } catch (e: unknown) {
          if (cancelled || isAbortError(e)) return;
          const live = useDawStore.getState();
          const warm =
            hadProjectAtStart &&
            live.projectPath === projectPath &&
            live.project != null &&
            isServerTimeoutError(e);
          if (warm && warmAttempts < WARM_SHELL_MAX_ATTEMPTS) {
            warmAttempts += 1;
            try {
              await delay(WARM_SHELL_RETRY_DELAY_MS, ac.signal);
            } catch {
              return;
            }
            continue;
          }
          setRetrying(false);
          setError(errorMessage(e));
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [enabled, projectPath, retryToken]);

  return { error, retrying, retry };
}
