import { useCallback, useEffect, useRef, useState } from "react";
import { guestExportFailed, startGuestExport } from "../../api";
import type { ExportedFilesLoad } from "../../stages/deliver/useExportedFiles";
import { ApiError } from "../../utils/apiError";

const JOB_RUNNING = "Another job is running. Try again shortly.";
const NOT_ALLOWED = "Exports from this link are not allowed.";
const RATE_LIMITED = "Too many requests. Try again soon.";
const NOT_STARTED = "The export could not be started. Try again.";
const NOT_FINISHED = "The export did not finish. Try again, or ask the host.";

type Phase = "idle" | "posting" | "settling" | "watching";

function startFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return NOT_STARTED;
  if (error.status === 409 && error.code === "job_running") return JOB_RUNNING;
  if (error.status === 403) return NOT_ALLOWED;
  if (error.status === 429) return RATE_LIMITED;
  return NOT_STARTED;
}

type Files = {
  exporting: boolean;
  currentLoad: ExportedFilesLoad;
  reload: () => void;
};

/**
 * Starting an export from a share link. `starting` lasts from the press until a files read
 * after the start has settled, so the button never shows enabled between the two. Once that
 * export ends the newest job is read once, and a failure shows fixed copy, never the host's.
 */
export function useGuestExport(
  projectKey: string | null,
  { exporting, currentLoad, reload }: Files,
): { start: () => void; starting: boolean; error: string | null } {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const pressed = useRef(false);

  const start = useCallback(() => {
    if (projectKey === null || pressed.current) return;
    pressed.current = true;
    setError(null);
    setPhase("posting");
    startGuestExport(projectKey).then(
      () => {
        setPhase("settling");
        reload();
      },
      (failure: unknown) => {
        pressed.current = false;
        setPhase("idle");
        setError(startFailure(failure));
        if (failure instanceof ApiError && failure.status !== 429) reload();
      },
    );
  }, [projectKey, reload]);

  useEffect(() => {
    if (phase === "settling" && currentLoad !== "loading") setPhase("watching");
  }, [phase, currentLoad]);

  useEffect(() => {
    if (phase !== "watching" || exporting || projectKey === null) return;
    setPhase("idle");
    pressed.current = false;
    guestExportFailed(projectKey).then(
      (failed) => {
        if (failed) setError(NOT_FINISHED);
      },
      () => undefined,
    );
  }, [phase, exporting, projectKey]);

  return {
    start,
    starting: phase === "posting" || phase === "settling",
    error,
  };
}
