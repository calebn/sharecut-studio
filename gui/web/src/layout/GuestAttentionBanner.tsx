import { useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  clearConflicts,
  clearHostConflicts,
  loadConflicts,
  loadHostCommandCount,
  loadHostConflicts,
  type OfflineConflict,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";
import { plural } from "../utils/format";

/** Pending host edits and host/guest 409 conflicts from IndexedDB. */
export function GuestAttentionBanner() {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
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
        ? Promise.resolve(0)
        : loadHostCommandCount(projectPath);
      void queue
        .catch(() => 0)
        .then((count) => {
          if (!cancelled) setPending(count);
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
            ? `${conflicts.length} ${plural(conflicts.length, "conflict")}`
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
