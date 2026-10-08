import { useEffect, useRef, useState } from "react";
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

type AttentionStatus =
  | "checking"
  | "ready"
  | "unreadable"
  | "retrying"
  | "dismissing";

/** Pending host edits and host/guest 409 conflicts from IndexedDB. */
export function GuestAttentionBanner() {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<AttentionStatus>("checking");
  const dismiss = useRef<(() => void) | null>(null);
  const token = isShareProjectKey(projectPath)
    ? shareTokenFromKey(projectPath)
    : null;

  useEffect(() => {
    setConflicts([]);
    setPending(0);
    let currentStatus: AttentionStatus = "checking";
    let generation = 0;
    let cancelled = false;
    const updateStatus = (next: AttentionStatus) => {
      currentStatus = next;
      setStatus(next);
    };
    updateStatus("checking");
    const refresh = () => {
      if (currentStatus === "dismissing") return;
      const read = ++generation;
      updateStatus(
        currentStatus === "unreadable" || currentStatus === "retrying"
          ? "retrying"
          : "checking",
      );
      const load = token
        ? loadConflicts(token)
        : loadHostConflicts(projectPath);
      const queue = token
        ? loadCommandQueue(token).then(() => 0)
        : loadHostCommandCount(projectPath);
      void Promise.all([queue, load])
        .then(([count, list]) => {
          if (cancelled || read !== generation) return;
          setPending(count);
          setConflicts(list);
          updateStatus("ready");
        })
        .catch(() => {
          if (!cancelled && read === generation) updateStatus("unreadable");
        });
    };
    dismiss.current = () => {
      if (cancelled || currentStatus !== "ready") return;
      const clearing = ++generation;
      updateStatus("dismissing");
      void (token ? clearConflicts(token) : clearHostConflicts(projectPath))
        .then(() => {
          if (cancelled || clearing !== generation) return;
          setConflicts([]);
          updateStatus("ready");
        })
        .catch(() => {
          if (!cancelled && clearing === generation) updateStatus("unreadable");
        });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      dismiss.current = null;
      window.clearInterval(id);
    };
  }, [projectPath, token]);

  return (
    <GuestAttentionBannerView
      pending={pending}
      conflicts={conflicts}
      unreadable={status === "unreadable" || status === "retrying"}
      checking={
        status === "checking" ||
        status === "retrying" ||
        status === "dismissing"
      }
      onDismissAll={() => dismiss.current?.()}
    />
  );
}
