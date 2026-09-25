import { submitDocumentCommand } from "../api";
import { shareProjectKey } from "../shareMode";
import { isClientRejection, isRetryLater } from "../utils/apiError";
import {
  loadCommandQueue,
  loadHostCommandQueue,
  removeHostQueuedCommands,
} from "./offlineStore";

/** Drain persisted share-guest commands in client_seq order after reconnect. */
export async function drainOfflineQueue(token: string): Promise<void> {
  const queue = [...(await loadCommandQueue(token))].sort(
    (a, b) => a.client_seq - b.client_seq,
  );
  const path = shareProjectKey(token);
  for (const cmd of queue) {
    try {
      await submitDocumentCommand(path, cmd.type, cmd.payload, {
        command_id: cmd.command_id,
        client_id: cmd.client_id,
        client_seq: cmd.client_seq,
        structural_mode: cmd.structural_mode,
        replaying: true,
      });
    } catch (error) {
      // A refused replay was recorded as a conflict and dequeued, so later
      // edits still drain. A rate limit, server or network error stays
      // queued and keeps order until the next drain.
      if (isClientRejection(error) && !isRetryLater(error)) {
        continue;
      }
      break;
    }
  }
}

/** Drain persisted host commands in insertion order after reconnect. */
export async function drainHostOfflineQueue(
  projectPath: string,
): Promise<void> {
  const queue = await loadHostCommandQueue(projectPath);
  const completed: string[] = [];
  for (const cmd of queue) {
    try {
      const result = await submitDocumentCommand(
        projectPath,
        cmd.type,
        cmd.payload,
        {
          command_id: cmd.command_id,
          client_id: cmd.client_id,
          client_seq: cmd.client_seq,
          structural_mode: cmd.structural_mode,
          replaying: true,
        },
      );
      if (result.queued === true) {
        break;
      }
      completed.push(cmd.command_id);
    } catch (error) {
      // A 4xx was already recorded as a conflict and dequeued; later,
      // unrelated edits must still drain. Network errors / 5xx keep order.
      if (isClientRejection(error)) {
        continue;
      }
      break;
    }
  }
  // One persisted update replaces N full-array rewrites on a long replay.
  await removeHostQueuedCommands(projectPath, completed);
}
