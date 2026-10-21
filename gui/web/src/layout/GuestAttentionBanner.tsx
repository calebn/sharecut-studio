import { runPointerCommand } from "../commands/pointer";
import { useOfflineAttentionAnnouncement } from "../hooks/useOfflineAttentionAnnouncement";
import { requestHostDrain } from "../services/offlineQueue/drainOfflineQueue";
import {
  dismissAllConflicts,
  refreshOfflineAttention,
  useOfflineAttention,
} from "../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../shareMode";
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
  useOfflineAttentionAnnouncement({
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
          : () =>
              runPointerCommand("view.setMobileMode", {
                mode: "more",
                destination: "history",
              })
      }
    />
  );
}
