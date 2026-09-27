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
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

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

  return (
    <GuestAttentionBannerView
      pending={pending}
      conflicts={conflicts}
      onDismissAll={() => {
        void (
          token ? clearConflicts(token) : clearHostConflicts(projectPath)
        ).then(() => setConflicts([]));
      }}
    />
  );
}
