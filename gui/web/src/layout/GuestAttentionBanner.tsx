import { useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  clearConflicts,
  clearHostConflicts,
  loadCommandQueue,
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
  const [unreadable, setUnreadable] = useState(false);
  const token = isShareProjectKey(projectPath)
    ? shareTokenFromKey(projectPath)
    : null;

  useEffect(() => {
    setConflicts([]);
    setPending(0);
    setUnreadable(false);
    let cancelled = false;
    const refresh = () => {
      const load = token
        ? loadConflicts(token)
        : loadHostConflicts(projectPath);
      const queue = token
        ? loadCommandQueue(token).then(() => 0)
        : loadHostCommandCount(projectPath);
      void Promise.all([queue, load])
        .then(([count, list]) => {
          if (cancelled) return;
          setPending(count);
          setConflicts(list);
          setUnreadable(false);
        })
        .catch(() => {
          if (!cancelled) setUnreadable(true);
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
      unreadable={unreadable}
      onDismissAll={() => {
        void (
          token ? clearConflicts(token) : clearHostConflicts(projectPath)
        ).then(() => setConflicts([]));
      }}
    />
  );
}
