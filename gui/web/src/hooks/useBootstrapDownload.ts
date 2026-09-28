import { useCallback, useState } from "react";
import { runBootstrap, waitForBootstrapJob } from "../api";
import { errorMessage } from "../utils/apiError";
import { useSingleFlight } from "./useSingleFlight";

/**
 * One bootstrap download with live progress text. On success `busy` stays
 * true until the caller `reset()`s (a dialog closes first).
 */
export function useBootstrapDownload() {
  const { busy: inFlight, run } = useSingleFlight();
  /** Set on success so `busy` holds until `reset()`. */
  const [held, setHeld] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setHeld(false);
    setProgress(null);
    setError(null);
  }, []);

  const download = useCallback(
    async (opts: { components: string[]; whisper_model?: string }) =>
      (await run(async () => {
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
          setHeld(true);
          return true;
        } catch (e: unknown) {
          setError(errorMessage(e));
          return false;
        }
      })) ?? false,
    [run],
  );

  return { busy: inFlight || held, progress, error, download, reset };
}
