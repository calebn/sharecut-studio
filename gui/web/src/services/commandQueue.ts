/** Persisted command order, replay, conflict, and result-application policy. */

import {
  postGuestDocumentCommand,
  postHostDocumentCommand,
} from "../api/documentTransport";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { isRetryLater, readApiFailure } from "../utils/apiError";
import {
  documentClientId,
  newCommandId,
  nextDocumentClientSeq,
} from "../utils/documentClient";

export async function submitQueuedDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: {
    command_id?: string;
    client_seq?: number;
    structural_mode?: "propose" | "apply";
    offline?: boolean;
    replaying?: boolean;
    client_id?: string;
  },
): Promise<Record<string, unknown>> {
  const command_id = opts?.command_id ?? newCommandId();
  const client_seq = opts?.client_seq ?? nextDocumentClientSeq();
  const bodyBase = {
    client_id: opts?.client_id ?? documentClientId(),
    client_seq,
    command_id,
    type,
    payload,
    ...(opts?.structural_mode ? { structural_mode: opts.structural_mode } : {}),
  };

  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const structural =
      type === "SplitAtTime" ||
      type === "DeleteClip" ||
      type === "RippleDeleteClip";
    const offline =
      opts?.offline === true ||
      (typeof navigator !== "undefined" && navigator.onLine === false);
    const structural_mode =
      opts?.structural_mode ?? (offline && structural ? "propose" : undefined);

    const { enqueueCommand, removeQueuedCommand } = await import(
      "../state/offlineStore"
    );
    await enqueueCommand(token, {
      command_id,
      client_id: bodyBase.client_id,
      client_seq,
      type,
      payload,
      structural_mode,
      created_at: Date.now(),
    });

    let res: Response;
    try {
      res = await postGuestDocumentCommand(token, {
        ...bodyBase,
        role: "guest",
        ...(structural_mode ? { structural_mode } : {}),
      });
    } catch (err) {
      // The request never reached the server. The command stays queued and
      // replays on reconnect, so the caller keeps its optimistic value.
      if (opts?.replaying) {
        throw err;
      }
      return { ok: true, queued: true, command_id, client_seq };
    }
    if (!res.ok) {
      const failure = await readApiFailure(res);
      if (opts?.replaying && isRetryLater(failure)) {
        // Nobody awaits a replay: keep it queued for the next drain.
        throw failure;
      }
      if (res.status === 409 || opts?.replaying) {
        // Record it, so the banner says why the edit was dropped.
        const { addConflict } = await import("../state/offlineStore");
        await addConflict(token, {
          command: {
            command_id,
            client_seq,
            type,
            payload,
            created_at: Date.now(),
          },
          reason: failure.message,
        });
      }
      // The caller reports a live refusal now. Replaying it later would
      // overwrite newer edits, as on the host.
      await removeQueuedCommand(token, command_id);
      throw failure;
    }
    await removeQueuedCommand(token, command_id);
    const data = (await res.json()) as Record<string, unknown>;
    if (useDawStore.getState().projectPath === projectPath) {
      applyDocumentResult(data);
    }
    return data;
  }
  const hostQueue = await import("../state/offlineStore");
  let enqueueResult = { persisted: false, hadPredecessor: false };
  if (opts?.replaying) {
    // A replay already owns its persisted queue record.
    enqueueResult.persisted = true;
  } else {
    try {
      enqueueResult = await hostQueue.enqueueHostCommand(projectPath, {
        command_id,
        client_id: bodyBase.client_id,
        client_seq,
        type,
        payload,
        structural_mode: opts?.structural_mode,
        created_at: Date.now(),
      });
    } catch (error) {
      // Direct send is safe only when a readable queue proves there is no older edit.
      let pending;
      try {
        pending = await hostQueue.loadHostCommandQueue(projectPath);
      } catch {
        throw error;
      }
      if (pending.length > 0) {
        throw new Error(
          "Cannot send this edit while older offline edits are pending",
        );
      }
    }
  }
  if (enqueueResult.hadPredecessor && !opts?.replaying) {
    return { ok: true, queued: true, command_id, client_seq };
  }
  let res: Response;
  try {
    res = await postHostDocumentCommand(projectPath, {
      ...bodyBase,
      role: "viewer",
    });
  } catch (err) {
    if (enqueueResult.persisted) {
      return { ok: true, queued: true, command_id, client_seq };
    }
    throw err;
  }
  if (!res.ok) {
    const failure = await readApiFailure(res);
    const detail = failure.message;
    if (res.status < 500) {
      // A 4xx will never succeed on retry. Record 409s, and any rejected
      // replay (nobody is awaiting it), so the banner says why it was dropped.
      if (res.status === 409 || opts?.replaying) {
        await hostQueue.addHostConflict(projectPath, {
          command: {
            command_id,
            client_seq,
            type,
            payload,
            created_at: Date.now(),
          },
          reason: detail,
        });
      }
      if (enqueueResult.persisted) {
        await hostQueue.removeHostQueuedCommand(projectPath, command_id);
      }
    }
    if (res.status >= 500 && enqueueResult.persisted) {
      return { ok: true, queued: true, command_id, client_seq };
    }
    throw failure;
  }
  if (enqueueResult.persisted && !opts?.replaying) {
    // The server already committed. Failed local cleanup must not invite a new edit.
    try {
      await hostQueue.removeHostQueuedCommand(projectPath, command_id);
    } catch {
      // A later idempotent replay will clean up this same command identity.
    }
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentResult(data);
  }
  return data;
}
