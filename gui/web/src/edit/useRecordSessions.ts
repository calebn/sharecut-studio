import { useEffect, useRef, useState } from "react";
import { loadHostRecordSessions } from "../api";

// Derived from the loader: importDirection keeps edit/ from importing record/types.
type RecordSessionSummary = Awaited<
  ReturnType<typeof loadHostRecordSessions>
>[number];

type Loaded = { projectPath: string; sessions: RecordSessionSummary[] };

/** A burst of history entries (an edit and its preview rebuild) is one fetch. */
const REFETCH_DEBOUNCE_MS = 300;

const NONE: RecordSessionSummary[] = [];

/**
 * The host's record sessions for the open project, fetched again whenever
 * `refreshKey` changes (the document's history head, so a land, a rename and an
 * undo of either all refetch). The last good answer stays until a newer one
 * lands, and a failed fetch keeps it. The first fetch is immediate and later ones
 * wait out a short debounce. A first-ever failure shows nothing and the next key
 * change tries again; there is no retry loop. Empty before the first answer, for
 * a share key (the endpoint is host-only), and when `enabled` is false.
 */
export function useRecordSessions(
  projectPath: string | null,
  refreshKey: string,
  enabled: boolean,
): RecordSessionSummary[] {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!enabled || !projectPath || refreshKey === "") {
      return;
    }
    let stale = false;
    const fetchNow = () =>
      loadHostRecordSessions(projectPath).then(
        (sessions) => {
          if (!stale) setLoaded({ projectPath, sessions });
        },
        () => {},
      );
    const delay = asked.current ? REFETCH_DEBOUNCE_MS : 0;
    asked.current = true;
    const timer = setTimeout(() => void fetchNow(), delay);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [projectPath, refreshKey, enabled]);
  return enabled && loaded?.projectPath === projectPath
    ? loaded.sessions
    : NONE;
}
