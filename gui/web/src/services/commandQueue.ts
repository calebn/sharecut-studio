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
  beginDocumentSend,
  DOCUMENT_SEND_WAIT_MS,
  type DocumentSend,
  noteSaveLanded,
  trackEditSave,
} from "../state/documentSendOrder";
import type { OfflineConflict, QueuedCommand } from "../state/offlineStore";
import {
  requestGuestDrainLazy,
  requestHostDrainLazy,
} from "../state/requestDrainLazy";
import { DocumentCommand } from "../types/documentCommands.generated";
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

export type HistoryCommandType =
  | typeof DocumentCommand.UndoHistory
  | typeof DocumentCommand.RedoHistory;

export function isHistoryCommand(type: string): type is HistoryCommandType {
  return (
    type === DocumentCommand.UndoHistory || type === DocumentCommand.RedoHistory
  );
}

function commandOutcome(
  command: QueuedCommand,
  kind: OfflineConflict["kind"],
  reason: string,
  replayable = false,
): OfflineConflict {
  return kind === "refused"
    ? { command, kind, reason, recovery: "edit-and-resubmit" }
    : {
        command,
        kind,
        reason,
        recovery:
          isHistoryCommand(command.type) || !replayable
            ? "inspect-history"
            : "retry-same-command",
      };
}

async function settleCommandOutcome(
  projectPath: string,
  command: QueuedCommand,
  outcome: OfflineConflict | null,
  removeFromQueue: boolean,
): Promise<void> {
  const token = shareTokenFromKey(projectPath);
  const store = await import("../state/offlineStore");
  try {
    if (token) {
      await store.settleGuestCommandOutcome(
        token,
        command.command_id,
        outcome,
        removeFromQueue,
      );
    } else {
      await store.settleHostCommandOutcome(
        projectPath,
        command.command_id,
        outcome,
        removeFromQueue,
      );
    }
    const attention = await import("../state/offlineAttention");
    attention.clearVolatileOutcome(projectPath, command.command_id);
  } catch {
    const attention = await import("../state/offlineAttention");
    if (outcome) {
      attention.recordVolatileOutcome(projectPath, outcome);
      if (removeFromQueue) throw new Error(outcome.reason);
    } else attention.clearVolatileOutcome(projectPath, command.command_id);
  }
}

export async function reconcileCommandBeforeReplay(
  projectPath: string,
  command: QueuedCommand,
): Promise<"send" | "skip" | "stop"> {
  const attention = await import("../state/offlineAttention");
  const volatile = attention.volatileOutcomeFor(
    projectPath,
    command.command_id,
  );
  let outcome: OfflineConflict | null = null;
  if (isHistoryCommand(command.type)) {
    outcome =
      volatile ??
      commandOutcome(
        command,
        "unknown",
        "Undo or Redo may have been applied. Check History before trying again.",
      );
  } else if (volatile?.kind === "refused") {
    outcome = volatile;
  }
  if (!outcome) return "send";
  try {
    await settleCommandOutcome(projectPath, command, outcome, true);
    return "skip";
  } catch {
    return "stop";
  }
}

interface DocumentCommandBody {
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

export function submitQueuedDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: DocumentCommandOptions,
): Promise<Record<string, unknown>> {
  const operation = submitQueuedDocumentCommandWithinOwnership(
    projectPath,
    type,
    payload,
    opts,
  );
  return opts?.replaying ? operation : trackEditSave(projectPath, operation);
}

async function submitQueuedDocumentCommandWithinOwnership(
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
      const pending = await queue.loadCommandQueue(token);
      requireCurrent();
      if (!pending.some((item) => item.command_id === identity.command_id)) {
        throw new Error(
          "Undo and Redo cannot run right now. Reload the project and try again.",
        );
      }
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
        await settleCommandOutcome(
          projectPath,
          cmd,
          commandOutcome(
            cmd,
            "unknown",
            "Undo or Redo may have been applied. Check History before trying again.",
          ),
          true,
        );
        throw new Error(
          "Undo or Redo may have been applied. Check History before trying again.",
        );
      }
      if (!reply.ok) {
        if (reply.status >= 500 || isRetryLater(reply.failure)) {
          await settleCommandOutcome(
            projectPath,
            cmd,
            commandOutcome(
              cmd,
              "unknown",
              "Undo or Redo may have been applied. Check History before trying again.",
            ),
            true,
          );
          throw new Error(
            "Undo or Redo may have been applied. Check History before trying again.",
          );
        }
        await settleCommandOutcome(
          projectPath,
          cmd,
          commandOutcome(cmd, "refused", reply.failure.message),
          true,
        );
        throw reply.failure;
      }
      await settleCommandOutcome(projectPath, cmd, null, true);
      const data = reply.data;
      if (useDawStore.getState().projectPath === projectPath) {
        applyDocumentResult(data, scope);
      }
      return data;
    } catch (error) {
      try {
        const attention = await import("../state/offlineAttention");
        if (!attention.volatileOutcomeFor(projectPath, identity.command_id)) {
          await queue.removeQueuedCommand(token, identity.command_id);
        }
      } catch {}
      throw error;
    }
  }

  const send = beginDocumentSend(projectPath, identity.command_id);
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
      await settleCommandOutcome(
        projectPath,
        cmd,
        commandOutcome(
          cmd,
          "unknown",
          "Undo or Redo may have been applied. Check History before trying again.",
        ),
        true,
      );
      throw new Error(
        "Undo or Redo may have been applied. Check History before trying again.",
      );
    }
    if (!reply.ok) {
      if (reply.status >= 500 || isRetryLater(reply.failure)) {
        await settleCommandOutcome(
          projectPath,
          cmd,
          commandOutcome(
            cmd,
            "unknown",
            "Undo or Redo may have been applied. Check History before trying again.",
          ),
          true,
        );
        throw new Error(
          "Undo or Redo may have been applied. Check History before trying again.",
        );
      }
      await settleCommandOutcome(
        projectPath,
        cmd,
        commandOutcome(cmd, "refused", reply.failure.message),
        true,
      );
      throw reply.failure;
    }
    await settleCommandOutcome(projectPath, cmd, null, true);
    if (useDawStore.getState().projectPath === projectPath) {
      applyDocumentResult(reply.data, scope);
    }
    return reply.data;
  } finally {
    try {
      const attention = await import("../state/offlineAttention");
      if (
        queue &&
        !attention.volatileOutcomeFor(projectPath, identity.command_id)
      ) {
        await queue.removeHostQueuedCommand(projectPath, identity.command_id);
      }
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

  const send = opts.replaying
    ? null
    : beginDocumentSend(projectPath, command_id);
  try {
    if (isShareProjectKey(projectPath)) {
      return await submitGuestDocumentCommand(
        projectPath,
        { scope, command_id, client_seq, type, payload, bodyBase },
        opts,
        send,
      );
    }
    return await submitHostDocumentCommand(
      projectPath,
      { scope, command_id, client_seq, type, payload, bodyBase },
      opts,
      send,
    );
  } finally {
    send?.finish();
  }
}

async function submitGuestDocumentCommand(
  projectPath: string,
  body: DocumentCommandBody,
  opts: ResolvedCommandOptions,
  send: DocumentSend | null,
): Promise<Record<string, unknown>> {
  const { command_id, client_seq, type, payload, bodyBase } = body;
  const token = shareTokenFromKey(projectPath)!;
  const structural =
    type === DocumentCommand.SplitAtTime ||
    type === DocumentCommand.DeleteClip ||
    type === DocumentCommand.EditSelectedRange;
  const offline =
    opts.offline === true ||
    (typeof navigator !== "undefined" && navigator.onLine === false);
  const structural_mode =
    opts.structural_mode ?? (offline && structural ? "propose" : undefined);

  const guestQueue = await import("../state/offlineStore");
  const admitted = await guestQueue.enqueueCommand(token, {
    command_id,
    client_id: bodyBase.client_id,
    client_seq,
    type,
    payload,
    structural_mode,
    created_at: Date.now(),
  });
  if (admitted.hadPredecessor && !opts.replaying) {
    const head = send
      ? await queueHeadAfterPriorSend(
          () => guestQueue.loadCommandQueue(token),
          command_id,
          send,
        )
      : null;
    if (!head) {
      requestGuestDrainLazy(token);
      return queuedResult(command_id, client_seq);
    }
  }

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
      await settleCommandOutcome(
        projectPath,
        {
          ...bodyBase,
          structural_mode,
          created_at: Date.now(),
        },
        commandOutcome(
          {
            ...bodyBase,
            structural_mode,
            created_at: Date.now(),
          },
          "unknown",
          "The server may have applied this edit. Retrying will reuse the same command.",
          admitted.persisted,
        ),
        false,
      );
      throw err;
    }
    const outcome = commandOutcome(
      {
        ...bodyBase,
        structural_mode,
        created_at: Date.now(),
      },
      "unknown",
      "The server may have applied this edit. Retrying will reuse the same command.",
      admitted.persisted,
    );
    await settleCommandOutcome(projectPath, outcome.command, outcome, false);
    if (admitted.persisted) return queuedResult(command_id, client_seq);
    throw err;
  }
  if (!reply.ok) {
    const failure = reply.failure;
    if (isRetryLater(failure) || reply.status >= 500) {
      const cmd = {
        ...bodyBase,
        structural_mode,
        created_at: Date.now(),
      };
      const outcome = commandOutcome(
        cmd,
        "unknown",
        "The server may have applied this edit. Retrying will reuse the same command.",
        admitted.persisted,
      );
      await settleCommandOutcome(projectPath, cmd, outcome, false);
      if (opts.replaying) throw failure;
      if (admitted.persisted) return queuedResult(command_id, client_seq);
      throw failure;
    }
    const cmd = {
      ...bodyBase,
      structural_mode,
      created_at: Date.now(),
    };
    await settleCommandOutcome(
      projectPath,
      cmd,
      commandOutcome(cmd, "refused", failure.message),
      true,
    );
    throw failure;
  }
  await settleCommandOutcome(
    projectPath,
    { ...bodyBase, structural_mode, created_at: Date.now() },
    null,
    true,
  );
  const data = reply.data;
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentResult(data, body.scope);
  }
  return data;
}

async function queueHeadAfterPriorSend(
  loadQueue: () => Promise<QueuedCommand[]>,
  commandId: string,
  send: DocumentSend,
): Promise<QueuedCommand | null> {
  const earlier = supportsCommandSendOwnership()
    ? raceTimeout(
        send.earlier.then(() => true),
        DOCUMENT_SEND_WAIT_MS,
        () => false,
      )
    : send.earlierWithin(DOCUMENT_SEND_WAIT_MS);
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
  body: DocumentCommandBody,
  opts: ResolvedCommandOptions,
  send: DocumentSend | null,
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
      const cmd: QueuedCommand = {
        command_id,
        client_id: bodyBase.client_id,
        client_seq,
        type,
        payload: bodyBase.payload,
        structural_mode: opts.structural_mode,
        created_at: Date.now(),
      };
      const outcome = commandOutcome(
        cmd,
        "unknown",
        "The server may have applied this edit. Retrying will reuse the same command.",
        true,
      );
      await settleCommandOutcome(projectPath, cmd, outcome, false);
      return queuedResult(command_id, client_seq);
    }
    const cmd: QueuedCommand = {
      command_id,
      client_id: bodyBase.client_id,
      client_seq,
      type,
      payload: bodyBase.payload,
      structural_mode: opts.structural_mode,
      created_at: Date.now(),
    };
    await settleCommandOutcome(
      projectPath,
      cmd,
      commandOutcome(
        cmd,
        "unknown",
        "The server may have applied this edit. Check the project before submitting it again.",
      ),
      false,
    );
    throw err;
  }
  if (!reply.ok) {
    const { failure, status } = reply;
    const cmd: QueuedCommand = {
      command_id,
      client_id: bodyBase.client_id,
      client_seq,
      type,
      payload: bodyBase.payload,
      structural_mode: opts.structural_mode,
      created_at: Date.now(),
    };
    if (isRetryLater(failure) || status >= 500) {
      const outcome = commandOutcome(
        cmd,
        "unknown",
        "The server may have applied this edit. Retrying will reuse the same command.",
        enqueueResult.persisted,
      );
      await settleCommandOutcome(projectPath, cmd, outcome, false);
      if (enqueueResult.persisted) return queuedResult(command_id, client_seq);
      throw failure;
    }
    await settleCommandOutcome(
      projectPath,
      cmd,
      commandOutcome(cmd, "refused", failure.message),
      enqueueResult.persisted,
    );
    throw failure;
  }
  await settleCommandOutcome(
    projectPath,
    {
      command_id,
      client_id: bodyBase.client_id,
      client_seq,
      type,
      payload: bodyBase.payload,
      structural_mode: opts.structural_mode,
      created_at: Date.now(),
    },
    null,
    enqueueResult.persisted && !opts.replaying,
  );
  const data = reply.data;
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentResult(data, body.scope);
  }
  return data;
}
