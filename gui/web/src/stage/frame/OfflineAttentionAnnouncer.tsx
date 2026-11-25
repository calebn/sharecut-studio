import { useOutbox } from "../../comments/useOutbox";
import { useOfflineAttentionAnnouncement } from "../../hooks/useOfflineAttentionAnnouncement";
import { useStorageAnnouncement } from "../../hooks/useStorageAnnouncement";
import { useOfflineAttention } from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey, shareTokenFromKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";

/** Draws nothing; speaks the Needs-attention summary on every stage, not only in the queue. */
export function OfflineAttentionAnnouncer() {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const {
    pending,
    conflicts: allConflicts,
    recoverySelection,
    status,
    loaded,
  } = useOfflineAttention(projectPath);
  useStorageAnnouncement();
  const posts = useOutbox(shareTokenFromKey(projectPath));
  const activeConflicts = allConflicts.filter(
    (conflict) => !conflict.dismissed,
  );
  const conflictCount = activeConflicts.length + (recoverySelection ? 1 : 0);
  useOfflineAttentionAnnouncement({
    projectPath,
    pending,
    guest: isShareProjectKey(projectPath),
    waitingPosts: posts.rows.length,
    returnedPosts: posts.returned.length,
    conflictCount,
    unreadable: status === "unreadable" || status === "retrying",
    dismissFailed: status === "dismiss-failed",
    loaded,
    status,
  });
  return null;
}
