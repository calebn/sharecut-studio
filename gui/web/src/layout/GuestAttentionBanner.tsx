import { useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  clearConflicts,
  loadConflicts,
  type OfflineConflict,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";

/** Needs-attention list for guest 409 conflicts (IndexedDB). */
export function GuestAttentionBanner() {
  const { projectPath } = useDaw();
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const token = isShareProjectKey(projectPath)
    ? shareTokenFromKey(projectPath)
    : null;

  useEffect(() => {
    if (!token) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void loadConflicts(token).then((list) => {
        if (!cancelled) {
          setConflicts(list);
        }
      });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token]);

  if (!token || conflicts.length === 0) {
    return null;
  }

  return (
    <div className="guest-attention" role="alert">
      <div className="guest-attention-head">
        <strong>Needs attention</strong>
        <span>
          {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="guest-attention-dismiss"
          onClick={() => {
            void clearConflicts(token).then(() => setConflicts([]));
          }}
        >
          Dismiss all
        </button>
      </div>
      <ul className="guest-attention-list">
        {conflicts.slice(0, 5).map((c) => (
          <li key={c.command.command_id}>
            <code>{c.command.type}</code>: {c.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
