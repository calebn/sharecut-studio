import { useMemo } from "react";
import { runPointerCommand } from "../../commands/pointer";
import {
  attentionRowsOf,
  type ReviewAttention,
} from "../../review/reviewQueueModel";
import { requestHostDrain } from "../../services/offlineQueue/drainOfflineQueue";
import {
  dismissAllConflicts,
  refreshOfflineAttention,
  useOfflineAttention,
} from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../../shareMode";

/** The project's unsent and unapplied offline edits as the Review queue's Needs attention rows. */
export function useReviewAttention(
  projectPath: string,
): ReviewAttention | undefined {
  const saved = useOfflineAttention(projectPath || null);
  return useMemo<ReviewAttention | undefined>(() => {
    if (!projectPath) return undefined;
    const share = isShareProjectKey(projectPath);
    const active = saved.conflicts.filter((conflict) => !conflict.dismissed);
    return {
      pending: share ? 0 : saved.pending,
      rows: attentionRowsOf(
        saved.recoverySelection ? [...active, saved.recoverySelection] : active,
        share,
      ),
      unreadable: saved.status === "unreadable" || saved.status === "retrying",
      dismissFailed: saved.status === "dismiss-failed",
      checking:
        saved.status === "checking" ||
        saved.status === "retrying" ||
        saved.status === "dismissing",
      canDismiss: active.length > 0,
      refineWaiverProject: share ? undefined : projectPath,
      onDismissAll: () => dismissAllConflicts(projectPath),
      onRetry: () => refreshOfflineAttention(projectPath),
      onSendNow: share
        ? undefined
        : () => {
            void requestHostDrain(projectPath);
          },
      onInspectHistory: share
        ? undefined
        : () => runPointerCommand("stage.edit", { sheet: "history" }),
    };
  }, [projectPath, saved]);
}
