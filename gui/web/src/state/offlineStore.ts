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

export interface OfflineConflict {
  command: QueuedCommand;
  reason: string;
}

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
    return {
      command: parseQueuedCommand(conflict.command),
      reason: conflict.reason,
    };
  });
}

async function updateStoredList<Item, Result>(
  key: string,
  parse: (value: unknown) => Item[],
  update: (items: Item[]) => { items: Item[]; result: Result },
): Promise<Result> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
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
        fail(transaction.error ?? new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => fail(transaction.error);
      const store = transaction.objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        try {
          const next = update(parse(req.result));
          result = next.result;
          store.put(next.items, key);
        } catch (error) {
          fail(error);
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
): Promise<Result> {
  return updateStoredList<QueuedCommand, Result>(
    hostQueueKey(projectPath),
    parseCommandList,
    (queue) => {
      const next = update(queue);
      return { items: next.queue, result: next.result };
    },
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

export async function clearConflicts(token: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await updateStoredList<OfflineConflict, void>(
    conflictKey(token),
    parseConflictList,
    () => ({ items: [], result: undefined }),
  );
}

export async function removeConflict(
  token: string,
  commandId: string,
): Promise<void> {
  const list = (await loadConflicts(token)).filter(
    (c) => c.command.command_id !== commandId,
  );
  await saveConflicts(token, list);
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
  await idbSet(queueKey(token), queue);
}

export async function enqueueCommand(
  token: string,
  cmd: QueuedCommand,
): Promise<void> {
  const queue = (await loadCommandQueue(token)).filter(
    (existing) => existing.command_id !== cmd.command_id,
  );
  queue.push(cmd);
  await saveCommandQueue(token, queue);
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
): Promise<{ persisted: boolean; hadPredecessor: boolean }> {
  if (typeof indexedDB === "undefined") {
    return { persisted: false, hadPredecessor: false };
  }
  return withHostQueueLock(projectPath, async () => {
    return updateHostQueue(projectPath, (existing) => {
      const existingIndex = existing.findIndex(
        (item) => item.command_id === cmd.command_id,
      );
      if (existingIndex >= 0) {
        return {
          queue: existing,
          result: { persisted: true, hadPredecessor: existingIndex > 0 },
        };
      }
      const queue = [...existing, chainQueuedEnvelopeBaseline(existing, cmd)];
      const hadPredecessor = existing.length > 0;
      return { queue, result: { persisted: true, hadPredecessor } };
    });
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
  const queue = (await loadCommandQueue(token)).filter(
    (c) => c.command_id !== commandId,
  );
  await saveCommandQueue(token, queue);
}

export async function loadConflicts(token: string): Promise<OfflineConflict[]> {
  return parseConflictList(await idbGet<unknown>(conflictKey(token)));
}

export async function saveConflicts(
  token: string,
  conflicts: OfflineConflict[],
): Promise<void> {
  await idbSet(conflictKey(token), conflicts);
}

export async function addConflict(
  token: string,
  conflict: OfflineConflict,
): Promise<void> {
  const list = await loadConflicts(token);
  list.push(conflict);
  await saveConflicts(token, list);
}

export async function loadHostConflicts(
  projectPath: string,
): Promise<OfflineConflict[]> {
  return parseConflictList(await idbGet<unknown>(hostConflictKey(projectPath)));
}

export async function saveHostConflicts(
  projectPath: string,
  conflicts: OfflineConflict[],
): Promise<void> {
  await idbSet(hostConflictKey(projectPath), conflicts);
}

export async function clearHostConflicts(projectPath: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await updateStoredList<OfflineConflict, void>(
    hostConflictKey(projectPath),
    parseConflictList,
    () => ({ items: [], result: undefined }),
  );
}

export async function addHostConflict(
  projectPath: string,
  conflict: OfflineConflict,
): Promise<void> {
  await updateStoredList<OfflineConflict, void>(
    hostConflictKey(projectPath),
    parseConflictList,
    (list) => ({
      items: [
        ...list.filter(
          (existing) =>
            existing.command.command_id !== conflict.command.command_id,
        ),
        conflict,
      ],
      result: undefined,
    }),
  );
}

/** Drop the host conflicts `superseded` matches, e.g. an earlier refused correction of a word just corrected (#746). */
export async function removeHostConflictsWhere(
  projectPath: string,
  superseded: (conflict: OfflineConflict) => boolean,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await updateStoredList<OfflineConflict, void>(
    hostConflictKey(projectPath),
    parseConflictList,
    (list) => ({
      items: list.filter((conflict) => !superseded(conflict)),
      result: undefined,
    }),
  );
}

/** Guest-token twin of `removeHostConflictsWhere`. */
export async function removeConflictsWhere(
  token: string,
  superseded: (conflict: OfflineConflict) => boolean,
): Promise<void> {
  const list = await loadConflicts(token);
  const kept = list.filter((conflict) => !superseded(conflict));
  if (kept.length !== list.length) {
    await saveConflicts(token, kept);
  }
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
