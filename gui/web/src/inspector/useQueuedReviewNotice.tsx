import { type ReactNode, useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { loadCommandQueue, loadHostCommandCount } from "../state/offlineStore";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";

/** How often a shown Still sending notice re-checks the project's command queue. */
export const QUEUED_NOTICE_POLL_MS = 1_000;

function queuedCommandCount(projectPath: string): Promise<number> {
  const token = isShareProjectKey(projectPath)
    ? shareTokenFromKey(projectPath)
    : null;
  return token
    ? loadCommandQueue(token).then((queue) => queue.length)
    : loadHostCommandCount(projectPath);
}

/**
 * The Still sending status for an Approve/Reject that stayed queued. It clears
 * itself once the project's command queue is empty: the drain sent the command,
 * or the host refused it and it moved to Needs attention.
 */
export function useQueuedReviewNotice(projectPath: string): {
  notice: ReactNode;
  setQueued: (queued: boolean) => void;
} {
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (!queued) {
      return;
    }
    let cancelled = false;
    const id = window.setInterval(() => {
      void queuedCommandCount(projectPath)
        // Unreadable queue: keep saying it is still sending.
        .catch(() => 1)
        .then((count) => {
          if (!cancelled && count === 0) {
            setQueued(false);
          }
        });
    }, QUEUED_NOTICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [queued, projectPath]);
  const notice = queued ? (
    <p className="ui-field-hint" role="status">
      {PENDING_REVIEW_QUEUED_MESSAGE}
    </p>
  ) : null;
  return { notice, setQueued };
}
