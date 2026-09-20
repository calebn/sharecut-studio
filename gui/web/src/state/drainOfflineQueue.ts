import { submitDocumentCommand } from "../api";
import { shareProjectKey } from "../shareMode";
import { loadCommandQueue } from "./offlineStore";

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
        client_seq: cmd.client_seq,
        structural_mode: cmd.structural_mode,
      });
    } catch {
      // Leave in queue / conflicts handled inside submitDocumentCommand.
      break;
    }
  }
}
