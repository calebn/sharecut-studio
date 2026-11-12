import { useCallback, useState } from "react";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { useDaw } from "../state/useDaw";
import type { ProjectView } from "../types/project";
import { ApiError, errorMessage } from "../utils/apiError";

/**
 * Shared busy/error wrapper for inspector/panel mutations that hit the project API.
 */
export function useProjectMutation(scope?: string): {
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  setError: (msg: string | null) => void;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  refresh: () => Promise<ProjectView>;
  projectPath: string;
} {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const [pending, setPending] = useState<readonly (string | undefined)[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    code: string | null;
    scope: string | undefined;
  } | null>(null);

  const setError = useCallback(
    (message: string | null) => {
      setFailure(message === null ? null : { message, code: null, scope });
    },
    [scope],
  );

  const refresh = useCallback(async () => {
    const next = await refreshDocumentProject(projectPath);
    return next;
  }, [projectPath]);

  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setPending((list) => [...list, scope]);
      setFailure(null);
      try {
        return await fn();
      } catch (e) {
        setFailure({
          message: errorMessage(e),
          code: e instanceof ApiError ? e.code : null,
          scope,
        });
        return undefined;
      } finally {
        setPending((list) => {
          const at = list.indexOf(scope);
          return at < 0 ? list : list.filter((_, i) => i !== at);
        });
      }
    },
    [scope],
  );

  const visible = failure !== null && failure.scope === scope ? failure : null;

  return {
    busy: scope === undefined ? pending.length > 0 : pending.includes(scope),
    error: visible?.message ?? null,
    errorCode: visible?.code ?? null,
    setError,
    run,
    refresh,
    projectPath,
  };
}
