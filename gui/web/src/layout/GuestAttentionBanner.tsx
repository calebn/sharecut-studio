import { useOfflineAttentionAnnouncement } from "../hooks/useOfflineAttentionAnnouncement";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { requestHostDrain } from "../state/drainOfflineQueue";
import {
  dismissAllConflicts,
  refreshOfflineAttention,
  useOfflineAttention,
} from "../state/offlineAttention";
import { useDaw } from "../state/useDaw";
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
  const { liveMessage, liveSeq } = useOfflineAttentionAnnouncement({
    projectPath,
    pending,
    conflictCount: conflicts.length,
    unreadable,
    dismissFailed: status === "dismiss-failed",
    loaded,
    status,
  });
  return (
    <GuestAttentionBannerView
      attentionLiveMessage={liveMessage}
      attentionLiveSeq={liveSeq}
      key={projectPath}
      host={host}
      pending={pending}
      conflicts={conflicts}
      canDismiss={activeConflicts.length > 0}
      guest={guest}
      unreadable={unreadable}
      dismissFailed={status === "dismiss-failed"}
      checking={
        status === "checking" ||
        status === "retrying" ||
        status === "dismissing"
      }
      onDismissAll={() => dismissAllConflicts(projectPath)}
      onSendNow={
        isShareProjectKey(projectPath)
          ? undefined
          : () => {
              void requestHostDrain(projectPath);
            }
      }
      onRetry={() => refreshOfflineAttention(projectPath)}
      onInspectHistory={
        guest
          ? undefined
          : () => useDawStore.getState().setMoreDestination("history")
      }
    />
  );
}
