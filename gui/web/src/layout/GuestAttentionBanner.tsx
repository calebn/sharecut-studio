import { useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  clearConflicts,
  clearHostConflicts,
  loadConflicts,
  loadHostCommandQueue,
  loadHostConflicts,
  type OfflineConflict,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";

/** Needs-attention list for guest 409 conflicts (IndexedDB). */
export function GuestAttentionBanner() {
  const { projectPath } = useDaw();
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const [pending, setPending] = useState(0);
  const token = isShareProjectKey(projectPath)
    ? shareTokenFromKey(projectPath)
    : null;

  useEffect(() => {
    setConflicts([]);
    setPending(0);
    let cancelled = false;
    const refresh = () => {
      const load = token
        ? loadConflicts(token)
        : loadHostConflicts(projectPath);
      const queue = token
        ? Promise.resolve([])
        : loadHostCommandQueue(projectPath);
      void queue
        .catch(() => [])
        .then((items) => {
          if (!cancelled) setPending(items.length);
        });
      void load
        .catch(() => [])
        .then((list) => {
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
  }, [projectPath, token]);

  if (conflicts.length === 0 && pending === 0) {
    return null;
  }

  return (
    <div className="guest-attention" role="alert">
      <div className="guest-attention-head">
        <strong>Needs attention</strong>
        <span>
          {pending > 0 ? `${pending} pending` : ""}
          {pending > 0 && conflicts.length > 0 ? ", " : ""}
          {conflicts.length > 0
            ? `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`
            : ""}
        </span>
        {conflicts.length > 0 && (
          <button
            type="button"
            className="guest-attention-dismiss"
            onClick={() => {
              void (
                token ? clearConflicts(token) : clearHostConflicts(projectPath)
              ).then(() => setConflicts([]));
            }}
          >
            Dismiss all
          </button>
        )}
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
