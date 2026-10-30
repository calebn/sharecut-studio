import { useEffect, useState } from "react";
import { loadHostRecordSessions } from "../api";
import type { RecordSessionSummary } from "./types";

type Loaded = { projectPath: string; session: RecordSessionSummary | null };

function newestEnded(
  sessions: readonly RecordSessionSummary[],
): RecordSessionSummary | null {
  return (
    sessions
      .filter((s) => s.state === "ended" && (s.takes.length > 0 || s.landed))
      .at(-1) ?? null
  );
}

/** The newest ended session worth summarising, fetched while `enabled`; a failed fetch just shows nothing. */
export function useLastEndedSession(
  projectPath: string | null,
  enabled: boolean,
): RecordSessionSummary | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    let stale = false;
    loadHostRecordSessions(projectPath).then(
      (sessions) => {
        if (!stale) {
          setLoaded({ projectPath, session: newestEnded(sessions) });
        }
      },
      () => {
        if (!stale) {
          setLoaded({ projectPath, session: null });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [enabled, projectPath]);
  return enabled && loaded?.projectPath === projectPath ? loaded.session : null;
}
