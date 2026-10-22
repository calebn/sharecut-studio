import { useCallback, useState } from "react";
import { runBootstrap, waitForBootstrapJob } from "../api";
import { ApiError, errorMessage } from "../utils/apiError";
import { plainError } from "../utils/plainError";
import { useSingleFlight } from "./useSingleFlight";

const BOOTSTRAP_BUSY_CODE = "bootstrap_job_running";

/**
 * One bootstrap download with live progress text. On success `busy` stays
 * true until the caller `reset()`s (a dialog closes first). `error` is safe to
 * show: a failure that names an internal id, setting or path reads as a plain
 * sentence naming `subject`.
 */
export function useBootstrapDownload(subject: string) {
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
          setProgress(null);
          if (e instanceof ApiError && e.code === BOOTSTRAP_BUSY_CODE) {
            setError(
              "Another download is already running. Try again when it finishes.",
            );
            return false;
          }
          const raw = errorMessage(e);
          const internal =
            plainError(raw) !== raw || /^[a-z][a-z0-9-]*:\s/.test(raw);
          setError(
            internal
              ? `Couldn't download ${subject}. Export diagnostics from the command palette and try again.`
              : raw,
          );
          return false;
        }
      })) ?? false,
    [run, subject],
  );

  return { busy: inFlight || held, progress, error, download, reset };
}
