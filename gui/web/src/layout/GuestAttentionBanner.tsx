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

/** Pending host edits and command outcomes from IndexedDB. */
export function GuestAttentionBanner() {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const { pending, conflicts, status } = useOfflineAttention(projectPath);
  const guest = isShareProjectKey(projectPath);
  return (
    <GuestAttentionBannerView
      pending={pending}
      conflicts={conflicts}
      guest={guest}
      unreadable={status === "unreadable" || status === "retrying"}
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
