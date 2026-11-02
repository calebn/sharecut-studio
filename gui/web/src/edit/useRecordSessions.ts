import { useEffect, useState } from "react";
import { loadHostRecordSessions } from "../api";

// Derived from the loader: importDirection keeps edit/ from importing record/types.
type RecordSessionSummary = Awaited<
  ReturnType<typeof loadHostRecordSessions>
>[number];

type Loaded = { projectPath: string; sessions: RecordSessionSummary[] };

const NONE: RecordSessionSummary[] = [];

/**
 * The host's record sessions for the open project, fetched again whenever
 * `refreshKey` changes (the document's history head, so a land, a rename and an
 * undo of either all refetch). The last good answer stays until a newer one
 * lands, and a failed fetch keeps it. Empty before the first answer, for a share
 * key (the endpoint is host-only), and when `enabled` is false.
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
        if (!stale) setLoaded({ projectPath, sessions });
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [projectPath, refreshKey, enabled]);
  return enabled && loaded?.projectPath === projectPath
    ? loaded.sessions
    : NONE;
}
