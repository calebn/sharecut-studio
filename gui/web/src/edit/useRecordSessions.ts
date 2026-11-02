import { useEffect, useState } from "react";
import { loadHostRecordSessions } from "../api";

type RecordSessionSummary = Awaited<
  ReturnType<typeof loadHostRecordSessions>
>[number];

type Loaded = {
  projectPath: string;
  refreshKey: string;
  sessions: RecordSessionSummary[];
};

const NONE: RecordSessionSummary[] = [];

/**
 * The host's record sessions for the open project, fetched when `refreshKey`
 * changes (it names the landed session clips, so a land or an undo refetches).
 * Empty while pending, on a failure, for a share key (the endpoint is host-only)
 * and when `enabled` is false; the caller shows no labels then.
 */
export function useRecordSessions(
  projectPath: string | null,
  refreshKey: string,
  enabled: boolean,
): RecordSessionSummary[] {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!enabled || !projectPath || refreshKey === "") {
      return;
    }
    let stale = false;
    loadHostRecordSessions(projectPath).then(
      (sessions) => {
        if (!stale) setLoaded({ projectPath, refreshKey, sessions });
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [projectPath, refreshKey, enabled]);
  return enabled &&
    loaded?.projectPath === projectPath &&
    loaded.refreshKey === refreshKey
    ? loaded.sessions
    : NONE;
}
