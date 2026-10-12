import {
  activateDocumentScope,
  type DocumentScope,
  documentScope,
  isCurrentDocumentScope,
  noteOwnCommandHead,
} from "../document/authorityState";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";
import { snapshotFromResult } from "../document/projectPatch";
/** Persisted command order, replay, conflict, and result-application policy. */

import {
  type DocumentCommandReply,
  postGuestDocumentCommand,
  postHostDocumentCommand,
} from "../api/documentTransport";
import {
  applyDocumentResult,
  refreshDocumentDisplay,
  refreshDocumentProject,
} from "../document/applyDocumentUpdate";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  supportsCommandSendOwnership,
  withCommandSendOwnership,
} from "../state/commandSendOwnership";
import { useDawStore } from "../state/dawStore";
import {
  beginHostSend,
  HOST_SEND_WAIT_MS,
  type HostSend,
  noteSaveLanded,
} from "../state/hostSendOrder";
import type { QueuedCommand } from "../state/offlineStore";
import {
  requestGuestDrainLazy,
  requestHostDrainLazy,
} from "../state/requestDrainLazy";
import { parseHistoryEntryId } from "../types/project";
import { ApiError, isRetryLater } from "../utils/apiError";
import {
  documentClientId,
  newCommandId,
  nextDocumentClientSeq,
} from "../utils/documentClient";
import { raceTimeout } from "../utils/raceTimeout";

type CommandIdentity = Pick<
  QueuedCommand,
  "client_id" | "command_id" | "client_seq"
>;
type CommandSettings = {
  structural_mode?: "propose" | "apply";
  offline?: boolean;
};
export type DocumentCommandOptions = CommandSettings &
  (
    | (Partial<CommandIdentity> & { replaying?: false })
    | (CommandIdentity & { replaying: true })
  );
type ResolvedCommandOptions = CommandSettings &
  CommandIdentity & { replaying: boolean };

export type HistoryCommandType = "UndoHistory" | "RedoHistory";

export function isHistoryCommand(type: string): type is HistoryCommandType {
  return type === "UndoHistory" || type === "RedoHistory";
}

interface HostCommandBody {
  scope: DocumentScope;
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

function isCommandIdentity(
  value: Partial<CommandIdentity>,
): value is CommandIdentity {
  return (
    typeof value.client_id === "string" &&
    value.client_id.length > 0 &&
    typeof value.command_id === "string" &&
    value.command_id.length > 0 &&
    typeof value.client_seq === "number" &&
    Number.isSafeInteger(value.client_seq) &&
    value.client_seq > 0
  );
}

function resolveCommandOptions(
  opts?: DocumentCommandOptions,
): ResolvedCommandOptions {
  if (opts?.replaying) {
    if (!isCommandIdentity(opts))
      throw new Error("Invalid document command identity");
    return opts;
  }
  if (
    (opts?.client_id !== undefined &&
      (typeof opts.client_id !== "string" || opts.client_id.length === 0)) ||
    (opts?.command_id !== undefined &&
      (typeof opts.command_id !== "string" || opts.command_id.length === 0)) ||
    (opts?.client_seq !== undefined &&
      (typeof opts.client_seq !== "number" ||
        !Number.isSafeInteger(opts.client_seq) ||
        opts.client_seq <= 0))
  )
    throw new Error("Invalid document command identity");
  const resolved = {
    ...opts,
    command_id: opts?.command_id ?? newCommandId(),
    client_seq: opts?.client_seq ?? nextDocumentClientSeq(),
    client_id: opts?.client_id ?? documentClientId(),
    replaying: false,
  };
  if (!isCommandIdentity(resolved))
    throw new Error("Invalid document command identity");
  return resolved;
}

export async function submitQueuedDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: DocumentCommandOptions,
): Promise<Record<string, unknown>> {
  if (isHistoryCommand(type)) {
    throw new Error("History commands must use submitLiveHistoryCommand");
  }
  const resolved = resolveCommandOptions(opts);
  const commandId = resolved.command_id;
  const active = useDawStore.getState().projectPath === projectPath;
  const scope = active ? activateDocumentScope(projectPath) : documentScope();
  if (active) beginDocumentDraft(commandId, type, payload, resolved.replaying);
  try {
    const result = await withCommandSendOwnership(projectPath, "shared", () =>
      submitCommand(projectPath, type, payload, resolved, scope),
    );
    const head = parseHistoryEntryId(result.history_head_id);
    if (head && result.queued !== true) {
      noteSaveLanded(projectPath, head, scope);
      const seq = snapshotFromResult(result)?.server_seq ?? result.server_seq;
      if (
        typeof seq === "number" &&
        Number.isSafeInteger(seq) &&
        seq > 0 &&
        active &&
        useDawStore.getState().projectPath === projectPath
      )
        noteOwnCommandHead(scope, {
          seq,
          head,
          displayedFrom:
            useDawStore.getState().project?.history.head_id ?? null,
        });
    }
    if (active && isCurrentDocumentScope(scope) && result.queued !== true) {
      finishDocumentDraft(commandId);
      refreshDocumentDisplay();
    }
    return result;
  } catch (error) {
    if (active && isCurrentDocumentScope(scope)) {
      finishDocumentDraft(commandId);
      refreshDocumentDisplay();
      if (error instanceof ApiError && error.code === "clip_fade_changed") {
        await refreshDocumentProject(projectPath).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function submitLiveHistoryCommand(
  projectPath: string,
  type: HistoryCommandType,
  payload: Record<string, unknown>,
  scope: DocumentScope,
): Promise<Record<string, unknown>> {
  if (scope.path !== projectPath || !isCurrentDocumentScope(scope)) {
    throw new ApiError(
      "The project changed before Undo or Redo could run",
      "history_stale",
      409,
    );
  }
  const resolved = resolveCommandOptions();
  const { command_id, client_seq, client_id } = resolved;
  const active = useDawStore.getState().projectPath === projectPath;
  if (active) beginDocumentDraft(command_id, type, payload, false);
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("Undo and Redo are unavailable offline");
    }
    const data = await withCommandSendOwnership(projectPath, "exclusive", () =>
      submitLiveHistoryIntent(projectPath, type, payload, scope, {
        command_id,
        client_id,
        client_seq,
      }),
    );
    const head = parseHistoryEntryId(data.history_head_id);
    if (head) {
      noteSaveLanded(projectPath, head, scope);
      const seq = snapshotFromResult(data)?.server_seq ?? data.server_seq;
      if (
        typeof seq === "number" &&
        Number.isSafeInteger(seq) &&
        seq > 0 &&
        active &&
        useDawStore.getState().projectPath === projectPath
      )
        noteOwnCommandHead(scope, {
          seq,
          head,
          displayedFrom:
            useDawStore.getState().project?.history.head_id ?? null,
        });
    }
    if (active && isCurrentDocumentScope(scope)) {
      finishDocumentDraft(command_id);
      refreshDocumentDisplay();
    }
    return data;
  } catch (error) {
    if (active && isCurrentDocumentScope(scope)) {
      finishDocumentDraft(command_id);
      refreshDocumentDisplay();
    }
    throw error;
  }
}

async function submitLiveHistoryIntent(
  projectPath: string,
  type: HistoryCommandType,
  payload: Record<string, unknown>,
  scope: DocumentScope,
  identity: CommandIdentity,
): Promise<Record<string, unknown>> {
  const offline = () =>
    typeof navigator !== "undefined" && navigator.onLine === false;
  const requireCurrent = () => {
    if (!isCurrentDocumentScope(scope)) {
      throw new ApiError(
        "The project changed before Undo or Redo could run",
        "history_stale",
        409,
      );
    }
    if (offline()) throw new Error("Undo and Redo are unavailable offline");
  };
  requireCurrent();
  const bodyBase = {
    ...identity,
    type,
    payload,
  };
  const cmd: QueuedCommand = {
    ...identity,
    type,
    payload,
    created_at: Date.now(),
  };
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const queue = await import("../state/offlineStore");
    requireCurrent();
    await queue.enqueueCommand(token, cmd);
    try {
      requireCurrent();
      const pending = [...(await queue.loadCommandQueue(token))].sort(
        (a, b) => a.client_seq - b.client_seq,
      );
      requireCurrent();
      const effective = pending.filter(
        (item) =>
          !isHistoryCommand(item.type) ||
          item.command_id === identity.command_id,
      );
      if (effective[0]?.command_id !== identity.command_id) {
        requestGuestDrainLazy(token);
        throw new Error("Undo and Redo must wait until older edits are sent");
      }
      requireCurrent();
      let reply: DocumentCommandReply;
      try {
        reply = await postGuestDocumentCommand(token, {
          ...bodyBase,
          role: "guest",
        });
      } catch {
        throw new Error(
          "Undo or Redo may have been applied. Check History before trying again.",
        );
      }
      if (!reply.ok) {
        try {
          await queue.removeQueuedCommand(token, identity.command_id);
        } catch {}
        if (reply.status >= 500) {
          throw new Error(
            "Undo or Redo may have been applied. Check History before trying again.",
          );
        }
        throw reply.failure;
      }
      try {
        await queue.removeQueuedCommand(token, identity.command_id);
      } catch {}
      const data = reply.data;
      if (useDawStore.getState().projectPath === projectPath) {
        applyDocumentResult(data, scope);
      }
      return data;
    } catch (error) {
      try {
        await queue.removeQueuedCommand(token, identity.command_id);
      } catch {}
      throw error;
    }
  }

  const send = beginHostSend(projectPath, identity.command_id);
  let queue: typeof import("../state/offlineStore") | null = null;
  try {
    queue = await import("../state/offlineStore");
    requireCurrent();
    const admitted = await queue.enqueueHostCommand(projectPath, cmd);
    requireCurrent();
    if (!admitted.persisted) {
      throw new Error(
        "Undo and Redo cannot run right now. Reload the project and try again.",
      );
    }
    const pending = await queue.loadHostCommandQueue(projectPath);
    requireCurrent();
    const effective = pending.filter(
      (item) =>
        !isHistoryCommand(item.type) || item.command_id === identity.command_id,
    );
    if (effective[0]?.command_id !== identity.command_id) {
      requestHostDrainLazy(projectPath);
      throw new Error("Undo and Redo must wait until older edits are sent");
    }
    requireCurrent();
    let reply: DocumentCommandReply;
    try {
      reply = await postHostDocumentCommand(projectPath, {
        ...bodyBase,
        role: "viewer",
      });
    } catch {
      throw new Error(
        "Undo or Redo may have been applied. Check History before trying again.",
      );
    }
    if (!reply.ok) {
      if (reply.status >= 500) {
        throw new Error(
          "Undo or Redo may have been applied. Check History before trying again.",
        );
      }
      throw reply.failure;
    }
    if (useDawStore.getState().projectPath === projectPath) {
      applyDocumentResult(reply.data, scope);
    }
    return reply.data;
  } finally {
    try {
      await queue?.removeHostQueuedCommand(projectPath, identity.command_id);
    } catch {}
    send.finish();
  }
}

async function submitCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown>,
  opts: ResolvedCommandOptions,
  scope: DocumentScope,
): Promise<Record<string, unknown>> {
  const { command_id, client_seq } = opts;
  const bodyBase = {
    client_id: opts.client_id,
    client_seq,
    command_id,
    type,
    payload,
    ...(opts.structural_mode ? { structural_mode: opts.structural_mode } : {}),
  };

  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const structural =
      type === "SplitAtTime" ||
      type === "DeleteClip" ||
      type === "EditSelectedRange";
    const offline =
      opts.offline === true ||
      (typeof navigator !== "undefined" && navigator.onLine === false);
    const structural_mode =
      opts.structural_mode ?? (offline && structural ? "propose" : undefined);

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
      if (opts.replaying) {
        throw err;
      }
      return queuedResult(command_id, client_seq);
    }
    if (!reply.ok) {
      const failure = reply.failure;
      if (opts.replaying && isRetryLater(failure)) {
        // Nobody awaits a replay: keep it queued for the next drain.
        throw failure;
      }
      if (reply.status === 409 || opts.replaying) {
        // Record it, so the banner says why the edit was dropped.
        const { addConflict } = await import("../state/offlineStore");
        await addConflict(token, {
          command: { ...bodyBase, structural_mode, created_at: Date.now() },
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
    try {
      await removeQueuedCommand(token, command_id);
    } catch {}
    const data = reply.data;
    if (useDawStore.getState().projectPath === projectPath) {
      applyDocumentResult(data, scope);
    }
    return data;
  }
  const hostBody: HostCommandBody = {
    scope,
    command_id,
    client_seq,
    type,
    payload,
    bodyBase,
  };
  if (opts.replaying) {
    return submitHostDocumentCommand(projectPath, hostBody, opts, null);
  }
  const send = beginHostSend(projectPath, command_id);
  try {
    return await submitHostDocumentCommand(projectPath, hostBody, opts, send);
  } finally {
    send.finish();
  }
}

async function queueHeadAfterPriorSend(
  loadQueue: () => Promise<QueuedCommand[]>,
  commandId: string,
  send: HostSend,
): Promise<QueuedCommand | null> {
  const earlier = supportsCommandSendOwnership()
    ? raceTimeout(
        send.earlier.then(() => true),
        HOST_SEND_WAIT_MS,
        () => false,
      )
    : send.earlierWithin(HOST_SEND_WAIT_MS);
  if (!(await earlier)) {
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
  opts: ResolvedCommandOptions,
  send: HostSend | null,
): Promise<Record<string, unknown>> {
  const { command_id, client_seq, type, payload } = body;
  let bodyBase = body.bodyBase;
  const hostQueue = await import("../state/offlineStore");
  let enqueueResult = { persisted: false, hadPredecessor: false };
  let persistenceFailed = false;
  let persistenceFallbackAllowed = false;
  if (opts.replaying) {
    // A replay already owns its persisted queue record.
    enqueueResult.persisted = true;
  } else {
    try {
      enqueueResult = await hostQueue.enqueueHostCommand(
        projectPath,
        {
          command_id,
          client_id: bodyBase.client_id,
          client_seq,
          type,
          payload,
          structural_mode: opts.structural_mode,
          created_at: Date.now(),
        },
        () => {
          persistenceFailed = true;
        },
      );
    } catch (error) {
      if (!persistenceFailed) throw error;
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
      persistenceFallbackAllowed = true;
    }
  }
  if (
    !opts.replaying &&
    !enqueueResult.persisted &&
    !persistenceFallbackAllowed
  ) {
    throw new Error("Cannot send this edit without local persistence");
  }
  if (enqueueResult.hadPredecessor && !opts.replaying) {
    // A predecessor that is this tab's own live send is not an offline edit:
    // wait for it, then send this command if nothing older remains.
    const head = send
      ? await queueHeadAfterPriorSend(
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
      if (opts.replaying && isRetryLater(failure)) {
        // A rate limit (429) or timeout (408) on a replay: nobody awaits it,
        // so keep it queued for the next drain, as the guest path does.
        throw failure;
      }
      // Any other 4xx will never succeed on retry. The drain
      // (`replayQueuedCommands`) skips past it, so it must be dequeued
      // before this throws. Record 409s, and any rejected replay (nobody is
      // awaiting it), so the banner says why it was dropped.
      if (status === 409 || opts.replaying) {
        await hostQueue.addHostConflict(projectPath, {
          command: { ...bodyBase, created_at: Date.now() },
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
  if (enqueueResult.persisted && !opts.replaying) {
    // The server already committed. Failed local cleanup must not invite a new edit.
    try {
      await hostQueue.removeHostQueuedCommand(projectPath, command_id);
    } catch {
      // A later idempotent replay will clean up this same command identity.
    }
  }
  const data = reply.data;
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentResult(data, body.scope);
  }
  return data;
}
