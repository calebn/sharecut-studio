/** Persisted command order, replay, conflict, and result-application policy. */

import {
  type DocumentCommandReply,
  postGuestDocumentCommand,
  postHostDocumentCommand,
} from "../api/documentTransport";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  beginHostSend,
  HOST_SEND_WAIT_MS,
  type HostSend,
} from "../state/hostSendOrder";
import type { QueuedCommand } from "../state/offlineStore";
import { requestHostDrainLazy } from "../state/requestDrainLazy";
import { isRetryLater } from "../utils/apiError";
import {
  documentClientId,
  newCommandId,
  nextDocumentClientSeq,
} from "../utils/documentClient";

export type DocumentCommandOptions = {
  command_id?: string;
  client_seq?: number;
  structural_mode?: "propose" | "apply";
  offline?: boolean;
  replaying?: boolean;
  client_id?: string;
};

interface HostCommandBody {
  command_id: string;
  client_seq: number;
  type: string;
  payload: Record<string, unknown>;
  bodyBase: {
    client_id: string;
    client_seq: number;
    command_id: string;
    type: string;
    payload: Record<string, unknown>;
    structural_mode?: "propose" | "apply";
  };
}

function queuedResult(
  command_id: string,
  client_seq: number,
): Record<string, unknown> {
  return { ok: true, queued: true, command_id, client_seq };
}

export async function submitQueuedDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: DocumentCommandOptions,
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

    let reply: DocumentCommandReply;
    try {
      reply = await postGuestDocumentCommand(token, {
        ...bodyBase,
        role: "guest",
        ...(structural_mode ? { structural_mode } : {}),
      });
    } catch (err) {
      // The request never reached the server, or its reply did not arrive in
      // time. The command stays queued and replays on reconnect, so the
      // caller keeps its optimistic value.
      if (opts?.replaying) {
        throw err;
      }
      return queuedResult(command_id, client_seq);
    }
    if (!reply.ok) {
      const failure = reply.failure;
      if (opts?.replaying && isRetryLater(failure)) {
        // Nobody awaits a replay: keep it queued for the next drain.
        throw failure;
      }
      if (reply.status === 409 || opts?.replaying) {
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
      // overwrite newer edits, as on the host. The drain
      // (`replayQueuedCommands`) skips past a permanent rejection, so it
      // must be dequeued before this throws.
      await removeQueuedCommand(token, command_id);
      throw failure;
    }
    await removeQueuedCommand(token, command_id);
    const data = reply.data;
    if (useDawStore.getState().projectPath === projectPath) {
      applyDocumentResult(data);
    }
    return data;
  }
  const hostBody: HostCommandBody = {
    command_id,
    client_seq,
    type,
    payload,
    bodyBase,
  };
  if (opts?.replaying) {
    return submitHostDocumentCommand(projectPath, hostBody, opts, null);
  }
  const send = beginHostSend(projectPath, command_id);
  try {
    return await submitHostDocumentCommand(projectPath, hostBody, opts, send);
  } finally {
    send.finish();
  }
}

/**
 * Wait (at most HOST_SEND_WAIT_MS in total) for this tab's earlier sends and
 * the host drain run in progress, then return this command's persisted record
 * if it is now the queue head. Null keeps it queued; the caller then requests
 * a drain.
 */
async function queueHeadAfterEarlierSends(
  loadQueue: () => Promise<QueuedCommand[]>,
  commandId: string,
  send: HostSend,
): Promise<QueuedCommand | null> {
  if (!(await send.earlierWithin(HOST_SEND_WAIT_MS))) {
    return null;
  }
  try {
    const queue = await loadQueue();
    return queue[0]?.command_id === commandId ? queue[0] : null;
  } catch {
    // Unreadable queue: stay queued to keep order; the drain retries it.
    return null;
  }
}

async function submitHostDocumentCommand(
  projectPath: string,
  body: HostCommandBody,
  opts: DocumentCommandOptions | undefined,
  send: HostSend | null,
): Promise<Record<string, unknown>> {
  const { command_id, client_seq, type, payload } = body;
  let bodyBase = body.bodyBase;
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
    // A predecessor that is this tab's own live send is not an offline edit:
    // wait for it, then send this command if nothing older remains.
    const head = send
      ? await queueHeadAfterEarlierSends(
          () => hostQueue.loadHostCommandQueue(projectPath),
          command_id,
          send,
        )
      : null;
    if (!head) {
      // Nothing in this call will send it, so make sure a drain does.
      requestHostDrainLazy(projectPath);
      return queuedResult(command_id, client_seq);
    }
    bodyBase = { ...bodyBase, payload: head.payload };
  }
  let reply: DocumentCommandReply;
  try {
    reply = await postHostDocumentCommand(projectPath, {
      ...bodyBase,
      role: "viewer",
    });
  } catch (err) {
    if (enqueueResult.persisted) {
      return queuedResult(command_id, client_seq);
    }
    throw err;
  }
  if (!reply.ok) {
    const { failure, status } = reply;
    const detail = failure.message;
    if (status < 500) {
      if (opts?.replaying && isRetryLater(failure)) {
        // A rate limit (429) or timeout (408) on a replay: nobody awaits it,
        // so keep it queued for the next drain, as the guest path does.
        throw failure;
      }
      // Any other 4xx will never succeed on retry. The drain
      // (`replayQueuedCommands`) skips past it, so it must be dequeued
      // before this throws. Record 409s, and any rejected replay (nobody is
      // awaiting it), so the banner says why it was dropped.
      if (status === 409 || opts?.replaying) {
        await hostQueue.addHostConflict(projectPath, {
          command: {
            command_id,
            client_seq,
            type,
            payload: bodyBase.payload,
            created_at: Date.now(),
          },
          reason: detail,
        });
      }
      if (enqueueResult.persisted) {
        await hostQueue.removeHostQueuedCommand(projectPath, command_id);
      }
    }
    if (status >= 500 && enqueueResult.persisted) {
      return queuedResult(command_id, client_seq);
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
  const data = reply.data;
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentResult(data);
  }
  return data;
}
