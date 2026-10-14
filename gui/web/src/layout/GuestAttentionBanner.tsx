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

export function GuestAttentionBanner() {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const {
    pending,
    conflicts: allConflicts,
    status,
  } = useOfflineAttention(projectPath);
  const conflicts = allConflicts.filter((conflict) => !conflict.dismissed);
  const guest = isShareProjectKey(projectPath);
  return (
    <GuestAttentionBannerView
      pending={pending}
      conflicts={conflicts}
      guest={guest}
      unreadable={status === "unreadable" || status === "retrying"}
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
