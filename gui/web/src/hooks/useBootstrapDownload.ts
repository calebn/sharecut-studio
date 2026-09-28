import { useCallback, useRef, useState } from "react";
import { runBootstrap, waitForBootstrapJob } from "../api";
import { errorMessage } from "../utils/apiError";

/**
 * One bootstrap download with live progress text. On success `busy` stays
 * true until the caller `reset()`s (a dialog closes first).
 */
export function useBootstrapDownload() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setBusy(false);
    setProgress(null);
    setError(null);
  }, []);

  const download = useCallback(
    async (opts: { components: string[]; whisper_model?: string }) => {
      if (inFlight.current) {
        return false;
      }
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setProgress("Starting download…");
      try {
        const started = await runBootstrap(opts);
        setProgress(started.job.message ?? "Downloading…");
        await waitForBootstrapJob(started.job.id, {
          onUpdate: (next) => {
            if (next.message) {
              setProgress(next.message);
            }
          },
        });
        return true;
      } catch (e: unknown) {
        setError(errorMessage(e));
        setBusy(false);
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [],
  );

  return { busy, progress, error, download, reset };
}
