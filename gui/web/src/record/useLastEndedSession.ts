import { useCallback, useEffect, useState } from "react";
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

/** The newest ended session worth summarising, fetched while `enabled`; a failed fetch just shows nothing.
 * `refresh` fetches again and keeps the shown card until the newer answer lands; an answer
 * from a superseded fetch is dropped. */
export function useLastEndedSession(
  projectPath: string | null,
  enabled: boolean,
): { session: RecordSessionSummary | null; refresh: () => void } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((n) => n + 1), []);
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
  }, [enabled, projectPath, round]);
  // A new project or a switch off clears the card; a refresh keeps it until the answer lands.
  useEffect(() => () => setLoaded(null), [enabled, projectPath]);
  const session =
    enabled && loaded?.projectPath === projectPath ? loaded.session : null;
  return { session, refresh };
}
