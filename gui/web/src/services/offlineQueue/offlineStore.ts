/** Minimal IndexedDB helpers for offline snapshot + command queue. */

import { chainQueuedEnvelopeBaseline } from "./queuedEnvelopeBaseline";

const DB_NAME = "podcast-daw-offline";
const DB_VERSION = 1;
const STORE = "kv";

export interface QueuedCommand {
  client_id: string;
  command_id: string;
  client_seq: number;
  type: string;
  payload: Record<string, unknown>;
  source_anchor?: { clip_id?: string; source_sec: number; track_id?: string };
  structural_mode?: "propose" | "apply";
  created_at: number;
}

/** What admitting a command to a persisted queue found: stored, and whether older rows precede it. */
export interface QueueAdmission {
  persisted: boolean;
  hadPredecessor: boolean;
}

export type OfflineConflict =
  | {
      command: QueuedCommand;
      kind: "refused";
      reason: string;
      recovery: "edit-and-resubmit";
      dismissed?: boolean;
      /** The project file itself is missing or damaged, so nothing can be saved until it is back. */
      blocksSave?: boolean;
    }
  | {
      command: QueuedCommand;
      kind: "unknown";
      reason: string;
      recovery: "retry-same-command" | "inspect-history";
      dismissed?: boolean;
    };

/** Persisted guest snapshot for offline reload (project + optional proxy manifest). */
export interface OfflineSnapshot {
  project?: unknown;
  manifest?: unknown;
  saved_at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") {
    return undefined;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    let value: T | undefined;
    req.onsuccess = () => {
      value = req.result as T | undefined;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function queueKey(token: string): string {
  return `queue:${token}`;
}

function hostQueueKey(projectPath: string): string {
  return `host-queue:${projectPath}`;
}

function snapKey(token: string): string {
  return `snap:${token}`;
}

function conflictKey(token: string): string {
  return `conflicts:${token}`;
}

function hostConflictKey(projectPath: string): string {
  return `host-conflicts:${projectPath}`;
}

const hostQueueLocks = new Map<string, Promise<void>>();

async function withHostQueueLock<T>(
  projectPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = hostQueueLocks.get(projectPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  hostQueueLocks.set(projectPath, chain);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (hostQueueLocks.get(projectPath) === chain) {
      hostQueueLocks.delete(projectPath);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseQueuedCommand(value: unknown): QueuedCommand {
  if (
    !isRecord(value) ||
    typeof value.client_id !== "string" ||
    value.client_id.length === 0 ||
    typeof value.command_id !== "string" ||
    value.command_id.length === 0 ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    typeof value.client_seq !== "number" ||
    !Number.isSafeInteger(value.client_seq) ||
    value.client_seq <= 0 ||
    !isRecord(value.payload) ||
    typeof value.created_at !== "number" ||
    !Number.isFinite(value.created_at) ||
    (value.structural_mode !== undefined &&
      value.structural_mode !== "propose" &&
      value.structural_mode !== "apply")
  )
    throw new Error("Invalid saved command");
  let source_anchor: QueuedCommand["source_anchor"];
  if (value.source_anchor !== undefined) {
    const anchor = value.source_anchor;
    if (
      !isRecord(anchor) ||
      typeof anchor.source_sec !== "number" ||
      !Number.isFinite(anchor.source_sec) ||
      (anchor.clip_id !== undefined && typeof anchor.clip_id !== "string") ||
      (anchor.track_id !== undefined && typeof anchor.track_id !== "string")
    )
      throw new Error("Invalid saved command anchor");
    source_anchor = {
      source_sec: anchor.source_sec,
      ...(anchor.clip_id === undefined ? {} : { clip_id: anchor.clip_id }),
      ...(anchor.track_id === undefined ? {} : { track_id: anchor.track_id }),
    };
  }
  return {
    client_id: value.client_id,
    command_id: value.command_id,
    client_seq: value.client_seq,
    type: value.type,
    payload: value.payload,
    created_at: value.created_at,
    ...(value.structural_mode === undefined
      ? {}
      : { structural_mode: value.structural_mode }),
    ...(source_anchor === undefined ? {} : { source_anchor }),
  };
}

function parseCommandList(value: unknown): QueuedCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid saved command list");
  return Array.from(value, parseQueuedCommand);
}

function parseConflictList(value: unknown): OfflineConflict[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid saved conflict list");
  return Array.from(value, (conflict: unknown) => {
    if (!isRecord(conflict) || typeof conflict.reason !== "string") {
      throw new Error("Invalid saved conflict");
    }
    if (
      conflict.dismissed !== undefined &&
      typeof conflict.dismissed !== "boolean"
    ) {
      throw new Error("Invalid saved conflict dismissal");
    }
    const command = parseQueuedCommand(conflict.command);
    const kind = conflict.kind;
    if (kind === "refused") {
      if (conflict.recovery !== "edit-and-resubmit") {
        throw new Error("Invalid saved conflict outcome");
      }
      return {
        command,
        reason: conflict.reason,
        kind,
        recovery: "edit-and-resubmit",
        ...(typeof conflict.dismissed === "boolean"
          ? { dismissed: conflict.dismissed }
          : {}),
        ...(conflict.blocksSave === true ? { blocksSave: true } : {}),
      };
    }
    if (kind === "unknown") {
      const recovery = conflict.recovery;
      if (recovery !== "retry-same-command" && recovery !== "inspect-history") {
        throw new Error("Invalid saved conflict outcome");
      }
      return {
        command,
        reason: conflict.reason,
        kind,
        recovery,
        ...(typeof conflict.dismissed === "boolean"
          ? { dismissed: conflict.dismissed }
          : {}),
      };
    }
    throw new Error("Invalid saved conflict outcome");
  });
}

export type OfflineAttentionData = {
  pending: number;
  conflicts: OfflineConflict[];
};

export type DismissalResult = {
  pending: number;
  conflicts: OfflineConflict[];
};

function readOfflineAttention(
  queueKeyValue: string,
  conflictKeyValue: string,
  countPending: boolean,
): Promise<OfflineAttentionData> {
  const dbPromise = openDb();
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const queueRequest = store.get(queueKeyValue);
        const conflictRequest = store.get(conflictKeyValue);
        let queue: QueuedCommand[] | undefined;
        let conflicts: OfflineConflict[] | undefined;
        const finish = () => {
          if (queue === undefined || conflicts === undefined) return;
          resolve({ pending: countPending ? queue.length : 0, conflicts });
        };
        queueRequest.onsuccess = () => {
          try {
            queue = parseCommandList(queueRequest.result);
            finish();
          } catch (error) {
            reject(error);
          }
        };
        conflictRequest.onsuccess = () => {
          try {
            conflicts = parseConflictList(conflictRequest.result);
            finish();
          } catch (error) {
            reject(error);
          }
        };
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function settleOfflineOutcome(
  queueKeyValue: string,
  conflictKeyValue: string,
  commandId: string,
  outcome: OfflineConflict | null,
  removeFromQueue: boolean,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const queueRequest = store.get(queueKeyValue);
        const conflictRequest = store.get(conflictKeyValue);
        let queue: QueuedCommand[] | undefined;
        let conflicts: OfflineConflict[] | undefined;
        let written = false;
        const write = () => {
          if (written || queue === undefined || conflicts === undefined) return;
          written = true;
          const nextQueue = removeFromQueue
            ? queue.filter((command) => command.command_id !== commandId)
            : queue;
          const previous = conflicts.find(
            (conflict) => conflict.command.command_id === commandId,
          );
          const nextConflicts = conflicts.filter(
            (conflict) => conflict.command.command_id !== commandId,
          );
          if (outcome) {
            const keepsDismissal =
              previous?.dismissed &&
              previous.command.client_id === outcome.command.client_id &&
              previous.command.client_seq === outcome.command.client_seq &&
              previous.kind === outcome.kind &&
              previous.recovery === outcome.recovery &&
              (outcomeIdentity(previous) === outcomeIdentity(outcome) ||
                (outcome.kind === "unknown" &&
                  outcome.recovery === "inspect-history"));
            nextConflicts.push(
              keepsDismissal ? { ...outcome, dismissed: true } : outcome,
            );
          }
          try {
            store.put(parseCommandList(nextQueue), queueKeyValue);
            store.put(parseConflictList(nextConflicts), conflictKeyValue);
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        queueRequest.onsuccess = () => {
          try {
            queue = parseCommandList(queueRequest.result);
            write();
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        conflictRequest.onsuccess = () => {
          try {
            conflicts = parseConflictList(conflictRequest.result);
            write();
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

async function updateStoredList<Item, Result>(
  key: string,
  parse: (value: unknown) => Item[],
  update: (items: Item[]) => { items: Item[]; result: Result },
  onPersistenceFailure?: () => void,
): Promise<Result> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    let admitted = false;
    const fail = (error: unknown, persistence = false) => {
      if (settled) return;
      settled = true;
      if (admitted && persistence) onPersistenceFailure?.();
      db.close();
      reject(error);
    };
    let tx: IDBTransaction | undefined;
    try {
      const transaction = db.transaction(STORE, "readwrite");
      tx = transaction;
      let result: Result;
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve(result);
      };
      transaction.onabort = () =>
        fail(
          transaction.error ?? new Error("IndexedDB transaction aborted"),
          true,
        );
      transaction.onerror = () => fail(transaction.error, true);
      const store = transaction.objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        try {
          const next = update(parse(req.result));
          const items = parse(next.items);
          result = next.result;
          admitted = true;
          store.put(items, key);
        } catch (error) {
          fail(error, admitted);
          try {
            transaction.abort();
          } catch {}
        }
      };
    } catch (error) {
      fail(error);
      try {
        tx?.abort();
      } catch {}
    }
  });
}

function updateHostQueue<Result>(
  projectPath: string,
  update: (queue: QueuedCommand[]) => {
    queue: QueuedCommand[];
    result: Result;
  },
  onPersistenceFailure?: () => void,
): Promise<Result> {
  return updateStoredList<QueuedCommand, Result>(
    hostQueueKey(projectPath),
    parseCommandList,
    (queue) => {
      const next = update(queue);
      return { items: next.queue, result: next.result };
    },
    onPersistenceFailure,
  );
}

export async function saveOfflineSnapshot(
  token: string,
  snapshot: OfflineSnapshot,
): Promise<void> {
  await idbSet(snapKey(token), snapshot);
}

export async function loadOfflineSnapshot(
  token: string,
): Promise<OfflineSnapshot | undefined> {
  return idbGet<OfflineSnapshot>(snapKey(token));
}

export async function clearOfflineSnapshot(token: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(snapKey(token));
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Merge patch into the existing offline snapshot (keeps prior project/manifest). */
export async function mergeOfflineSnapshot(
  token: string,
  patch: Partial<OfflineSnapshot>,
): Promise<void> {
  const prev = (await loadOfflineSnapshot(token)) ?? { saved_at: 0 };
  await saveOfflineSnapshot(token, {
    ...prev,
    ...patch,
    saved_at: Date.now(),
  });
}

export async function loadCommandQueue(
  token: string,
): Promise<QueuedCommand[]> {
  return parseCommandList(await idbGet<unknown>(queueKey(token)));
}

export async function saveCommandQueue(
  token: string,
  queue: QueuedCommand[],
): Promise<void> {
  await idbSet(queueKey(token), parseCommandList(queue));
}

/**
 * The one admission rule for both queues: append `cmd`, or keep the row that
 * already has its `command_id` where it stands. A replay re-admits the row it
 * is sending, and neither rewriting it nor moving it to the tail may reorder it
 * behind later edits if the pass stops there. `hadPredecessor` tells a live
 * send whether older rows are queued ahead.
 */
function admitCommand(
  queue: QueuedCommand[],
  cmd: QueuedCommand,
  append: (queue: QueuedCommand[], cmd: QueuedCommand) => QueuedCommand,
): { items: QueuedCommand[]; result: QueueAdmission } {
  const index = queue.findIndex((item) => item.command_id === cmd.command_id);
  if (index >= 0) {
    return {
      items: queue,
      result: { persisted: true, hadPredecessor: index > 0 },
    };
  }
  return {
    items: [...queue, append(queue, cmd)],
    result: { persisted: true, hadPredecessor: queue.length > 0 },
  };
}

export async function enqueueCommand(
  token: string,
  cmd: QueuedCommand,
): Promise<QueueAdmission> {
  cmd = parseQueuedCommand(cmd);
  if (typeof indexedDB === "undefined") {
    return { persisted: false, hadPredecessor: false };
  }
  return updateStoredList<QueuedCommand, QueueAdmission>(
    queueKey(token),
    parseCommandList,
    (queue) => admitCommand(queue, cmd, (_queue, row) => row),
  );
}

export async function loadHostCommandQueue(
  projectPath: string,
): Promise<QueuedCommand[]> {
  return parseCommandList(await idbGet<unknown>(hostQueueKey(projectPath)));
}

export async function loadHostCommandCount(
  projectPath: string,
): Promise<number> {
  return (await loadHostCommandQueue(projectPath)).length;
}

export async function enqueueHostCommand(
  projectPath: string,
  cmd: QueuedCommand,
  onPersistenceFailure?: () => void,
): Promise<QueueAdmission> {
  cmd = parseQueuedCommand(cmd);
  if (typeof indexedDB === "undefined") {
    return { persisted: false, hadPredecessor: false };
  }
  return withHostQueueLock(projectPath, async () => {
    return updateHostQueue(
      projectPath,
      (existing) => {
        const { items, result } = admitCommand(
          existing,
          cmd,
          chainQueuedEnvelopeBaseline,
        );
        return { queue: items, result };
      },
      onPersistenceFailure,
    );
  });
}

export async function removeHostQueuedCommand(
  projectPath: string,
  commandId: string,
): Promise<void> {
  await removeHostQueuedCommands(projectPath, [commandId]);
}

export async function removeHostQueuedCommands(
  projectPath: string,
  commandIds: string[],
): Promise<void> {
  if (commandIds.length === 0) return;
  if (typeof indexedDB === "undefined") return;
  const ids = new Set(commandIds);
  await withHostQueueLock(projectPath, async () => {
    await updateHostQueue(projectPath, (existing) => ({
      queue: existing.filter((c) => !ids.has(c.command_id)),
      result: undefined,
    }));
  });
}

export async function removeQueuedCommand(
  token: string,
  commandId: string,
): Promise<void> {
  await removeQueuedCommands(token, [commandId]);
}

export async function removeQueuedCommands(
  token: string,
  commandIds: string[],
): Promise<void> {
  if (commandIds.length === 0 || typeof indexedDB === "undefined") return;
  const ids = new Set(commandIds);
  await updateStoredList<QueuedCommand, void>(
    queueKey(token),
    parseCommandList,
    (queue) => ({
      items: queue.filter((command) => !ids.has(command.command_id)),
      result: undefined,
    }),
  );
}

async function loadConflictList(key: string): Promise<OfflineConflict[]> {
  return parseConflictList(await idbGet<unknown>(key));
}

function updateConflictList(
  key: string,
  update: (conflicts: OfflineConflict[]) => OfflineConflict[],
): Promise<void> {
  return updateStoredList<OfflineConflict, void>(
    key,
    parseConflictList,
    (conflicts) => ({ items: update(conflicts), result: undefined }),
  );
}

async function clearConflictList(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await updateConflictList(key, () => []);
}

async function addToConflictList(
  key: string,
  conflict: OfflineConflict,
): Promise<void> {
  const admitted = parseConflictList([conflict]);
  await updateConflictList(key, (conflicts) => [
    ...conflicts.filter(
      (existing) => existing.command.command_id !== conflict.command.command_id,
    ),
    ...admitted,
  ]);
}

async function removeFromConflictList(
  key: string,
  superseded: (conflict: OfflineConflict) => boolean,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await updateConflictList(key, (conflicts) =>
    conflicts.filter((conflict) => !superseded(conflict)),
  );
}

export function loadConflicts(token: string): Promise<OfflineConflict[]> {
  return loadConflictList(conflictKey(token));
}

export function clearConflicts(token: string): Promise<void> {
  return clearConflictList(conflictKey(token));
}

export function addConflict(
  token: string,
  conflict: OfflineConflict,
): Promise<void> {
  return addToConflictList(conflictKey(token), conflict);
}

/** Drop the guest conflicts `superseded` matches, e.g. an earlier refused correction of a word just corrected (#746). */
export function removeConflictsWhere(
  token: string,
  superseded: (conflict: OfflineConflict) => boolean,
): Promise<void> {
  return removeFromConflictList(conflictKey(token), superseded);
}

export function loadHostConflicts(
  projectPath: string,
): Promise<OfflineConflict[]> {
  return loadConflictList(hostConflictKey(projectPath));
}

export function clearHostConflicts(projectPath: string): Promise<void> {
  return clearConflictList(hostConflictKey(projectPath));
}

function outcomeIdentity(conflict: OfflineConflict): string {
  const { command } = conflict;
  return JSON.stringify([
    command.command_id,
    command.client_id,
    command.client_seq,
    conflict.kind,
    conflict.reason,
    conflict.recovery,
  ]);
}

function dismissOfflineOutcomes(
  queueKeyValue: string,
  conflictKeyValue: string,
  captured: readonly OfflineConflict[],
  countPending: boolean,
): Promise<DismissalResult> {
  const identities = new Set(captured.map(outcomeIdentity));
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const queueRequest = store.get(queueKeyValue);
        const conflictRequest = store.get(conflictKeyValue);
        let queue: QueuedCommand[] | undefined;
        let conflicts: OfflineConflict[] | undefined;
        let result: DismissalResult | undefined;
        let written = false;
        const write = () => {
          if (written || queue === undefined || conflicts === undefined) return;
          written = true;
          const currentIds = new Set(
            conflicts.map((conflict) => conflict.command.command_id),
          );
          const additions = captured.filter(
            (conflict) => !currentIds.has(conflict.command.command_id),
          );
          const nextConflicts = [...conflicts, ...additions].map((conflict) =>
            identities.has(outcomeIdentity(conflict))
              ? { ...conflict, dismissed: true }
              : conflict,
          );
          const retired = new Set(
            captured
              .filter((conflict) => conflict.kind === "refused")
              .filter((conflict) =>
                nextConflicts.some(
                  (current) =>
                    current.kind === "refused" &&
                    outcomeIdentity(current) === outcomeIdentity(conflict) &&
                    current.dismissed,
                ),
              )
              .map((conflict) => conflict.command.command_id),
          );
          const nextQueue = queue.filter((command) => {
            if (!retired.has(command.command_id)) return true;
            const capturedRefusal = captured.find(
              (conflict) =>
                conflict.kind === "refused" &&
                conflict.command.command_id === command.command_id &&
                conflict.command.client_id === command.client_id &&
                conflict.command.client_seq === command.client_seq,
            );
            return !capturedRefusal;
          });
          result = {
            pending: countPending ? nextQueue.length : 0,
            conflicts: nextConflicts,
          };
          try {
            store.put(parseCommandList(nextQueue), queueKeyValue);
            store.put(parseConflictList(nextConflicts), conflictKeyValue);
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        queueRequest.onsuccess = () => {
          try {
            queue = parseCommandList(queueRequest.result);
            write();
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        conflictRequest.onsuccess = () => {
          try {
            conflicts = parseConflictList(conflictRequest.result);
            write();
          } catch (error) {
            reject(error);
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          db.close();
          if (result === undefined) {
            reject(new Error("Dismissal completed without a snapshot"));
          } else {
            resolve(result);
          }
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export function dismissConflicts(
  token: string,
  captured: readonly OfflineConflict[],
): Promise<DismissalResult> {
  return dismissOfflineOutcomes(
    queueKey(token),
    conflictKey(token),
    captured,
    false,
  );
}

export function dismissHostConflicts(
  projectPath: string,
  captured: readonly OfflineConflict[],
): Promise<DismissalResult> {
  return dismissOfflineOutcomes(
    hostQueueKey(projectPath),
    hostConflictKey(projectPath),
    captured,
    true,
  );
}

export function addHostConflict(
  projectPath: string,
  conflict: OfflineConflict,
): Promise<void> {
  return addToConflictList(hostConflictKey(projectPath), conflict);
}

export function loadHostAttention(
  projectPath: string,
): Promise<OfflineAttentionData> {
  return readOfflineAttention(
    hostQueueKey(projectPath),
    hostConflictKey(projectPath),
    true,
  );
}

export function loadGuestAttention(
  token: string,
): Promise<OfflineAttentionData> {
  return readOfflineAttention(queueKey(token), conflictKey(token), false);
}

export function settleHostCommandOutcome(
  projectPath: string,
  commandId: string,
  outcome: OfflineConflict | null,
  removeFromQueue: boolean,
): Promise<void> {
  return withHostQueueLock(projectPath, () =>
    settleOfflineOutcome(
      hostQueueKey(projectPath),
      hostConflictKey(projectPath),
      commandId,
      outcome,
      removeFromQueue,
    ),
  );
}

export function settleGuestCommandOutcome(
  token: string,
  commandId: string,
  outcome: OfflineConflict | null,
  removeFromQueue: boolean,
): Promise<void> {
  return settleOfflineOutcome(
    queueKey(token),
    conflictKey(token),
    commandId,
    outcome,
    removeFromQueue,
  );
}

/** Drop the host conflicts `superseded` matches, e.g. an earlier refused correction of a word just corrected (#746). */
export function removeHostConflictsWhere(
  projectPath: string,
  superseded: (conflict: OfflineConflict) => boolean,
): Promise<void> {
  return removeFromConflictList(hostConflictKey(projectPath), superseded);
}

function recordParticipantKey(token: string): string {
  return `record:${token}:participant`;
}

export type RecordParticipantLease = {
  participant_id: string;
  lease: string;
};

export async function saveRecordParticipant(
  token: string,
  value: RecordParticipantLease,
): Promise<void> {
  await idbSet(recordParticipantKey(token), value);
}

export async function loadRecordParticipant(
  token: string,
): Promise<RecordParticipantLease | undefined> {
  return idbGet<RecordParticipantLease>(recordParticipantKey(token));
}

export async function clearRecordParticipant(token: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(recordParticipantKey(token));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
