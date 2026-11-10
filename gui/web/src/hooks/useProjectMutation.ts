import { useCallback, useState } from "react";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { useDaw } from "../state/useDaw";
import type { ProjectView } from "../types/project";
import { ApiError, errorMessage } from "../utils/apiError";

/**
 * Shared busy/error wrapper for inspector/panel mutations that hit the project API.
 */
export function useProjectMutation(): {
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  setError: (msg: string | null) => void;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  refresh: () => Promise<ProjectView>;
  projectPath: string;
} {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const [pending, setPending] = useState(0);
  const [error, setErrorState] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const setError = useCallback((message: string | null) => {
    setErrorState(message);
    setErrorCode(null);
  }, []);

  const refresh = useCallback(async () => {
    const next = await refreshDocumentProject(projectPath);
    return next;
  }, [projectPath]);

  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setPending((n) => n + 1);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setErrorState(errorMessage(e));
        setErrorCode(e instanceof ApiError ? e.code : null);
        return undefined;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [setError],
  );

  return {
    busy: pending > 0,
    error,
    errorCode,
    setError,
    run,
    refresh,
    projectPath,
  };
}
