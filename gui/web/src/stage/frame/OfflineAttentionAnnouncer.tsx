import { useOfflineAttentionAnnouncement } from "../../hooks/useOfflineAttentionAnnouncement";
import { useOfflineAttention } from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";

/**
 * Speaks the Needs-attention summary through the live region. It draws
 * nothing: the rows and their actions live in the Review queue, but the
 * summary must be spoken on every stage.
 */
export function OfflineAttentionAnnouncer() {
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
  const conflictCount = activeConflicts.length + (recoverySelection ? 1 : 0);
  useOfflineAttentionAnnouncement({
    projectPath,
    pending: isShareProjectKey(projectPath) ? 0 : pending,
    conflictCount,
    unreadable: status === "unreadable" || status === "retrying",
    dismissFailed: status === "dismiss-failed",
    loaded,
    status,
  });
  return null;
}
