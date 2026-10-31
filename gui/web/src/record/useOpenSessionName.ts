import { useEffect, useState } from "react";
import { loadHostRecordSessions } from "../api";
import type { RecordSessionSummary } from "./types";

/** What the open room's header calls the session: the host's name, else "Session N". */
export function sessionLabel(
  row: Pick<RecordSessionSummary, "name" | "planned_number">,
): string {
  return row.name ?? `Session ${row.planned_number}`;
}

type Loaded = { projectPath: string; sessionId: string; label: string };

/** The open session's header label, fetched per room and again when `refreshKey` changes; null until known or when the fetch fails. */
export function useOpenSessionName(
  projectPath: string | null,
  sessionId: string | null,
  refreshKey?: string,
): string | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!projectPath || !sessionId) {
      return;
    }
    let stale = false;
    loadHostRecordSessions(projectPath).then(
      (sessions) => {
        const row = sessions.find((s) => s.session_id === sessionId);
        if (!stale && row) {
          setLoaded({ projectPath, sessionId, label: sessionLabel(row) });
        }
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [projectPath, sessionId, refreshKey]);
  return loaded?.projectPath === projectPath && loaded?.sessionId === sessionId
    ? loaded.label
    : null;
}
