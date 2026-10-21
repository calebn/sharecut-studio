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
import { DocumentCommand } from "../types/documentCommands.generated";
import { parseHistoryEntryId } from "../types/project";
import { ApiError, isRetryLater } from "../utils/apiError";
import {
  documentClientId,
  newCommandId,
  nextDocumentClientSeq,
} from "../utils/documentClient";
import { raceTimeout } from "../utils/raceTimeout";
import {
  clearVolatileOutcome,
  recordVolatileOutcome,
  volatileOutcomeFor,
} from "./offlineQueue/offlineAttention";
import {
  enqueueCommand,
  enqueueHostCommand,
  loadCommandQueue,
  loadHostCommandQueue,
  type OfflineConflict,
  type QueueAdmission,
  type QueuedCommand,
  removeHostQueuedCommand,
  removeQueuedCommand,
  settleGuestCommandOutcome,
  settleHostCommandOutcome,
} from "./offlineQueue/offlineStore";
import {
  requestGuestDrainLazy,
  requestHostDrainLazy,
} from "./offlineQueue/requestDrainLazy";
import { clearSupersededCorrectionConflicts } from "./offlineQueue/supersededCorrections";

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
  try {
    if (token) {
      await settleGuestCommandOutcome(
        token,
        command.command_id,
        outcome,
        removeFromQueue,
      );
    } else {
      await settleHostCommandOutcome(
        projectPath,
        command.command_id,
        outcome,
        removeFromQueue,
      );
    }
    clearVolatileOutcome(projectPath, command.command_id);
  } catch {
    if (outcome) {
      recordVolatileOutcome(projectPath, outcome);
      if (removeFromQueue) throw new Error(outcome.reason);
    } else clearVolatileOutcome(projectPath, command.command_id);
  }
}

export async function reconcileCommandBeforeReplay(
  projectPath: string,
  command: QueuedCommand,
): Promise<"send" | "skip" | "stop"> {
  const volatile = volatileOutcomeFor(projectPath, command.command_id);
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
    // A replay clears its own in drainOfflineQueue.ts.
    if (!resolved.replaying && result.queued !== true) {
      await clearSupersededCorrectionConflicts(projectPath, type, payload);
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
    requireCurrent();
    await enqueueCommand(token, cmd);
    try {
      requireCurrent();
      const pending = await loadCommandQueue(token);
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
        if (!volatileOutcomeFor(projectPath, identity.command_id)) {
          await removeQueuedCommand(token, identity.command_id);
        }
      } catch {}
      throw error;
    }
  }

  const send = beginDocumentSend(projectPath, identity.command_id);
  try {
    requireCurrent();
    const admitted = await enqueueHostCommand(projectPath, cmd);
    requireCurrent();
    if (!admitted.persisted) {
      throw new Error(
        "Undo and Redo cannot run right now. Reload the project and try again.",
      );
    }
    const pending = await loadHostCommandQueue(projectPath);
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
      if (!volatileOutcomeFor(projectPath, identity.command_id)) {
        await removeHostQueuedCommand(projectPath, identity.command_id);
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
    return await submitThroughQueue(
      projectPath,
      { scope, command_id, client_seq, type, payload, bodyBase },
      opts,
      send,
    );
  } finally {
    send?.finish();
  }
}

const RETRY_REASON =
  "The server may have applied this edit. Retrying will reuse the same command.";

/**
 * What differs between the host and share-guest submit paths. Everything else
 * (admit to the persisted queue, wait for an earlier send, post, settle the
 * outcome, apply the result) is one flow in `submitThroughQueue`.
 */
interface SubmitSide {
  role: "viewer" | "guest";
  structuralMode(): "propose" | "apply" | undefined;
  /** Persist the command; throws when it must not be sent without a record. */
  admit(cmd: QueuedCommand): Promise<QueueAdmission>;
  loadQueue: () => Promise<QueuedCommand[]>;
  requestDrain: () => void;
  post(body: Record<string, unknown>): Promise<DocumentCommandReply>;
  /** Post the queued head's payload when an earlier send left it ahead of us. */
  adoptQueuedPayload: boolean;
  /** A replayed send that did not land is rethrown instead of reported queued. */
  rethrowUnlandedReplay: boolean;
  /** This call removes its own row on landing or refusal, even unpersisted. */
  ownsQueueRow: boolean;
  /** Why an unpersisted send that never got a reply has an unknown outcome. */
  unpersistedTransportReason: string;
}

function guestSide(
  projectPath: string,
  type: string,
  opts: ResolvedCommandOptions,
): SubmitSide {
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
  return {
    role: "guest",
    structuralMode: () => structural_mode,
    admit: (cmd) => enqueueCommand(token, cmd),
    loadQueue: () => loadCommandQueue(token),
    requestDrain: () => requestGuestDrainLazy(token),
    post: (body) => postGuestDocumentCommand(token, body),
    adoptQueuedPayload: false,
    rethrowUnlandedReplay: true,
    ownsQueueRow: true,
    unpersistedTransportReason: RETRY_REASON,
  };
}

function hostSide(
  projectPath: string,
  opts: ResolvedCommandOptions,
): SubmitSide {
  return {
    role: "viewer",
    structuralMode: () => opts.structural_mode,
    admit: async (cmd) => {
      // A replay already owns its persisted queue record.
      if (opts.replaying) return { persisted: true, hadPredecessor: false };
      let persistenceFailed = false;
      let admitted: QueueAdmission;
      try {
        admitted = await enqueueHostCommand(projectPath, cmd, () => {
          persistenceFailed = true;
        });
      } catch (error) {
        if (!persistenceFailed) throw error;
        // Direct send is safe only when a readable queue proves there is no older edit.
        let pending;
        try {
          pending = await loadHostCommandQueue(projectPath);
        } catch {
          throw error;
        }
        if (pending.length > 0) {
          throw new Error(
            "Cannot send this edit while older offline edits are pending",
          );
        }
        return { persisted: false, hadPredecessor: false };
      }
      if (!admitted.persisted) {
        throw new Error("Cannot send this edit without local persistence");
      }
      return admitted;
    },
    loadQueue: () => loadHostCommandQueue(projectPath),
    requestDrain: () => requestHostDrainLazy(projectPath),
    post: (body) => postHostDocumentCommand(projectPath, body),
    adoptQueuedPayload: true,
    rethrowUnlandedReplay: false,
    ownsQueueRow: false,
    unpersistedTransportReason:
      "The server may have applied this edit. Check the project before submitting it again.",
  };
}

async function submitThroughQueue(
  projectPath: string,
  body: DocumentCommandBody,
  opts: ResolvedCommandOptions,
  send: DocumentSend | null,
): Promise<Record<string, unknown>> {
  const { command_id, client_seq, type, payload } = body;
  let bodyBase = body.bodyBase;
  const side = isShareProjectKey(projectPath)
    ? guestSide(projectPath, type, opts)
    : hostSide(projectPath, opts);
  const structural_mode = side.structuralMode();
  const queued = (): QueuedCommand => ({
    ...bodyBase,
    structural_mode,
    created_at: Date.now(),
  });

  const admitted = await side.admit({
    command_id,
    client_id: bodyBase.client_id,
    client_seq,
    type,
    payload,
    structural_mode,
    created_at: Date.now(),
  });
  if (admitted.hadPredecessor && !opts.replaying) {
    // A predecessor that is this tab's own live send is not an offline edit:
    // wait for it, then send this command if nothing older remains.
    const head = send
      ? await queueHeadAfterPriorSend(side.loadQueue, command_id, send)
      : null;
    if (!head) {
      // Nothing in this call will send it, so make sure a drain does.
      side.requestDrain();
      return queuedResult(command_id, client_seq);
    }
    if (side.adoptQueuedPayload) {
      bodyBase = { ...bodyBase, payload: head.payload };
    }
  }

  // The command stays queued and replays on reconnect unless this call is
  // a guest replay, whose caller owns the retry.
  const staysQueued =
    admitted.persisted && !(opts.replaying && side.rethrowUnlandedReplay);
  let reply: DocumentCommandReply;
  try {
    reply = await side.post({
      ...bodyBase,
      ...(structural_mode ? { structural_mode } : {}),
      role: side.role,
    });
  } catch (err) {
    // The request never reached the server, or its reply did not arrive in
    // time.
    const cmd = queued();
    await settleCommandOutcome(
      projectPath,
      cmd,
      commandOutcome(
        cmd,
        "unknown",
        admitted.persisted ? RETRY_REASON : side.unpersistedTransportReason,
        admitted.persisted,
      ),
      false,
    );
    if (staysQueued) return queuedResult(command_id, client_seq);
    throw err;
  }
  if (!reply.ok) {
    const { failure, status } = reply;
    const cmd = queued();
    if (isRetryLater(failure) || status >= 500) {
      await settleCommandOutcome(
        projectPath,
        cmd,
        commandOutcome(cmd, "unknown", RETRY_REASON, admitted.persisted),
        false,
      );
      if (staysQueued) return queuedResult(command_id, client_seq);
      throw failure;
    }
    await settleCommandOutcome(
      projectPath,
      cmd,
      commandOutcome(cmd, "refused", failure.message),
      side.ownsQueueRow || admitted.persisted,
    );
    throw failure;
  }
  await settleCommandOutcome(
    projectPath,
    queued(),
    null,
    side.ownsQueueRow || (admitted.persisted && !opts.replaying),
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
