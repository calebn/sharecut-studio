import { useOfflineAttentionAnnouncement } from "../../hooks/useOfflineAttentionAnnouncement";
import {
  dismissAllConflicts,
  refreshOfflineAttention,
  useOfflineAttention,
} from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

export function GuestAttentionBanner({
  host = null,
}: {
  host?: HTMLElement | null;
}) {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const {
    pending,
    conflicts: allConflicts,
    recoverySelection,
    status,
    loaded,
  } = useOfflineAttention(projectPath);
  const activeConflicts = allConflicts.filter(
    (conflict) => !conflict.dismissed,
  );
  const conflicts = recoverySelection
    ? [...activeConflicts, recoverySelection]
    : activeConflicts;
  const guest = isShareProjectKey(projectPath);
  const unreadable = status === "unreadable" || status === "retrying";
  useOfflineAttentionAnnouncement({
    projectPath,
    pending: guest ? 0 : pending,
    conflictCount: conflicts.length,
    unreadable,
    dismissFailed: status === "dismiss-failed",
    loaded,
    status,
  });
  if (!guest) return null;
  return (
    <GuestAttentionBannerView
      key={projectPath}
      host={host}
      conflicts={conflicts}
      canDismiss={activeConflicts.length > 0}
      unreadable={unreadable}
      dismissFailed={status === "dismiss-failed"}
      checking={
        status === "checking" ||
        status === "retrying" ||
        status === "dismissing"
      }
      onDismissAll={() => dismissAllConflicts(projectPath)}
      onRetry={() => refreshOfflineAttention(projectPath)}
    />
  );
}
