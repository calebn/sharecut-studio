import { useCallback, useState } from "react";
import { refreshProject } from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { useDaw } from "../state/useDaw";
import type { ProjectView } from "../types/project";

/**
 * Shared busy/error wrapper for inspector/panel mutations that hit the project API.
 */
export function useProjectMutation(): {
  busy: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  refresh: () => Promise<ProjectView>;
  projectPath: string;
} {
  const { projectPath } = useDaw();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await refreshProject(projectPath);
    applyDocumentSnapshot({ project: next }, { force: true });
    return next;
  }, [projectPath]);

  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, error, setError, run, refresh, projectPath };
}
