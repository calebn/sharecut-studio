import { submitDocumentCommand } from "../api";
import { shareProjectKey } from "../shareMode";
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
      });
    } catch {
      // Leave in queue / conflicts handled inside submitDocumentCommand.
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
    } catch {
      break;
    }
  }
  // One persisted update replaces N full-array rewrites on a long replay.
  await removeHostQueuedCommands(projectPath, completed);
}
