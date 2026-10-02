import { type ReactNode, useCallback, useEffect, useState } from "react";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  loadCommandQueue,
  loadConflicts,
  loadHostCommandCount,
  loadHostCommandQueue,
  loadHostConflicts,
  type QueuedCommand,
} from "../state/offlineStore";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";

/** How often a shown Still sending notice re-checks the project's command queue. */
export const QUEUED_NOTICE_POLL_MS = 1_000;

type TimingSettlement = Readonly<{
  commandId: string;
  outcome: "applied" | "rejected";
}>;
type TimingQueueState = Readonly<{
  projectPath: string;
  editId: string;
  queued: boolean;
  settlement: TimingSettlement | null;
}>;

function targetsPendingEdit(command: QueuedCommand, editId: string): boolean {
  return command.type === "UpdatePendingEdit"
    ? command.payload.id === editId
    : (command.type === "ApproveEdits" || command.type === "RejectEdits") &&
        Array.isArray(command.payload.ids) &&
        command.payload.ids.includes(editId);
}

async function queuedCommandCount(projectPath: string): Promise<number> {
  const token = shareTokenFromKey(projectPath);
  return token
    ? (await loadCommandQueue(token)).length
    : loadHostCommandCount(projectPath);
}

/**
 * Review notices clear when their queue drains. An inspector's edit id also restores
 * its timing lock from the durable queue and checks its submitted command's outcome.
 */
export function useQueuedReviewNotice(
  projectPath: string,
  timingEditId?: string,
): {
  notice: ReactNode;
  queued: boolean;
  checking: boolean;
  settlement: TimingSettlement | null;
  setQueued: (queued: boolean, timingCommandId?: string) => void;
} {
  const [localQueued, setLocalQueued] = useState(false);
  const [tracking, setTracking] = useState<{
    projectPath: string;
    editId: string;
    commandId: string;
  } | null>(null);
  const [timingQueue, setTimingQueue] = useState<TimingQueueState | null>(null);
  const commandId =
    tracking?.projectPath === projectPath && tracking.editId === timingEditId
      ? tracking.commandId
      : null;
  const currentTiming =
    timingQueue?.projectPath === projectPath &&
    timingQueue.editId === timingEditId
      ? timingQueue
      : null;
  const checking = timingEditId != null && !currentTiming;
  const queued = localQueued || currentTiming?.queued === true;
  const setQueued = useCallback(
    (value: boolean, timingCommandId?: string) => {
      setLocalQueued(value);
      setTracking(
        value && timingEditId != null && timingCommandId
          ? { projectPath, editId: timingEditId, commandId: timingCommandId }
          : null,
      );
    },
    [projectPath, timingEditId],
  );

  useEffect(() => {
    if (timingEditId != null || !localQueued) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void queuedCommandCount(projectPath)
        .catch(() => 1)
        .then((count) => {
          if (!cancelled && count === 0) setLocalQueued(false);
        });
    }, QUEUED_NOTICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [localQueued, projectPath, timingEditId]);

  useEffect(() => {
    if (timingEditId == null) return;
    let cancelled = false;
    let reading = false;
    const token = isShareProjectKey(projectPath)
      ? shareTokenFromKey(projectPath)
      : null;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const queue = token
          ? await loadCommandQueue(token)
          : await loadHostCommandQueue(projectPath);
        let settlement: TimingSettlement | null = null;
        if (
          commandId &&
          !queue.some((command) => command.command_id === commandId)
        ) {
          const conflicts = token
            ? await loadConflicts(token)
            : await loadHostConflicts(projectPath);
          settlement = {
            commandId,
            outcome: conflicts.some(
              (conflict) => conflict.command.command_id === commandId,
            )
              ? "rejected"
              : "applied",
          };
        }
        if (!cancelled) {
          setTimingQueue({
            projectPath,
            editId: timingEditId,
            queued: queue.some((command) =>
              targetsPendingEdit(command, timingEditId),
            ),
            settlement,
          });
          setLocalQueued(false);
        }
      } catch {
        // An unreadable queue or outcome keeps the current lock until the next poll.
      } finally {
        reading = false;
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), QUEUED_NOTICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectPath, timingEditId, commandId]);

  const notice =
    queued || checking ? (
      <p className="ui-field-hint" role="status">
        {queued ? PENDING_REVIEW_QUEUED_MESSAGE : "Checking queued timing…"}
      </p>
    ) : null;
  return {
    notice,
    queued,
    checking,
    settlement: currentTiming?.settlement ?? null,
    setQueued,
  };
}
