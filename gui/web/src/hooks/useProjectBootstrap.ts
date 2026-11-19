import { useCallback, useEffect, useState } from "react";
import { loadDocumentState, UnusableAnswerError } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import {
  autoRetryMsOf,
  classifyShellFailure,
  type ShellFailure,
} from "../shellLoadFailure";
import { useDawStore } from "../state/dawStore";
import { isAbortError, isServerTimeoutError } from "../utils/apiError";
import { isShareProjectKey } from "../utils/can";

interface BootstrapOwner {
  projectPath: string;
  enabled: boolean;
  attempt: number;
}

interface BootstrapRead {
  owner: BootstrapOwner;
  failure: ShellFailure | null;
  retrying: boolean;
}

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
 *
 * A failure is kept as a closed `ShellFailure` chosen when it happens, never
 * as text: what the server said cannot reach a screen through this hook. A
 * guest's failure that promises a retry (asleep, offline, busy, rate-limited)
 * is retried here, on the page's own clock; a host's never is.
 */
export function useProjectBootstrap(
  projectPath: string,
  enabled = true,
): {
  /** Why the load failed; it stays through a retry and clears when the load succeeds. */
  failure: ShellFailure | null;
  /** An attempt is in flight while a failure is showing: a press, the page's own retry, or the connection coming back. */
  retrying: boolean;
  /** Which attempt this is, for `useBackOnline`. */
  attempt: number;
  /** Try again now: the cover's button, the loading screen's Retry, the connection back. */
  retry: () => void;
} {
  const [read, setRead] = useState<BootstrapRead>(() => ({
    owner: { projectPath, enabled, attempt: 0 },
    failure: null,
    retrying: false,
  }));
  const { owner } = read;
  if (owner.projectPath !== projectPath || owner.enabled !== enabled) {
    setRead({
      owner: { projectPath, enabled, attempt: 0 },
      failure: null,
      retrying: false,
    });
  }
  const retry = useCallback(() => {
    setRead((current) => ({
      ...current,
      owner: { ...current.owner, attempt: current.owner.attempt + 1 },
      // The failure stays on screen through the press: a press from the
      // loading screen, when nothing has failed, shows no failure at all.
      retrying: current.failure !== null,
    }));
  }, []);

  useEffect(() => {
    if (!enabled || !projectPath) return;
    const scope = activateDocumentScope(projectPath);
    return () => {
      if (isCurrentDocumentScope(scope)) resetDocumentAuthority();
    };
  }, [enabled, projectPath]);

  useEffect(() => {
    const { enabled, projectPath } = owner;
    if (!enabled || !projectPath) {
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const scope = activateDocumentScope(projectPath);
    const hadProjectAtStart = useDawStore.getState().project != null;
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
          try {
            applyDocumentSnapshot(shell, { scope });
          } catch {
            throw new UnusableAnswerError("The document could not be applied");
          }
          setRead((current) =>
            current.owner === owner
              ? { ...current, failure: null, retrying: false }
              : current,
          );
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
          const failure = classifyShellFailure(
            e,
            isShareProjectKey(projectPath) ? "guest" : "host",
            navigator.onLine !== false,
          );
          setRead((current) =>
            current.owner === owner
              ? { ...current, failure, retrying: false }
              : current,
          );
          const wait = autoRetryMsOf(failure);
          if (wait === null) return;
          try {
            await delay(wait, ac.signal);
          } catch {
            return;
          }
          setRead((current) =>
            current.owner === owner ? { ...current, retrying: true } : current,
          );
          continue;
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [owner]);

  return {
    failure: read.failure,
    retrying: read.retrying,
    attempt: owner.attempt,
    retry,
  };
}
