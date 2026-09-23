/** Minimal IndexedDB helpers for offline snapshot + command queue. */

import { chainQueuedEnvelopeBaseline } from "./queuedEnvelopeBaseline";

const DB_NAME = "podcast-daw-offline";
const DB_VERSION = 1;
const STORE = "kv";

export interface QueuedCommand {
  client_id?: string;
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

function hostQueueCountKey(projectPath: string): string {
  return `host-queue-count:${projectPath}`;
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

async function updateStoredList<Item, Result>(
  key: string,
  update: (items: Item[]) => { items: Item[]; result: Result },
  countKey?: string,
): Promise<Result> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    let result: Result;
    req.onsuccess = () => {
      const next = update((req.result as Item[] | undefined) ?? []);
      result = next.result;
      store.put(next.items, key);
      if (countKey) store.put(next.items.length, countKey);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
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

function updateHostQueue<Result>(
  projectPath: string,
  update: (queue: QueuedCommand[]) => {
    queue: QueuedCommand[];
    result: Result;
  },
): Promise<Result> {
  return updateStoredList<QueuedCommand, Result>(
    hostQueueKey(projectPath),
    (queue) => {
      const next = update(queue);
      return { items: next.queue, result: next.result };
    },
    hostQueueCountKey(projectPath),
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
  await saveConflicts(token, []);
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
  return (await idbGet<QueuedCommand[]>(queueKey(token))) ?? [];
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
  return (await idbGet<QueuedCommand[]>(hostQueueKey(projectPath))) ?? [];
}

export async function loadHostCommandCount(
  projectPath: string,
): Promise<number> {
  const count = await idbGet<number>(hostQueueCountKey(projectPath));
  return count ?? (await loadHostCommandQueue(projectPath)).length;
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
  return (await idbGet<OfflineConflict[]>(conflictKey(token))) ?? [];
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
  return (await idbGet<OfflineConflict[]>(hostConflictKey(projectPath))) ?? [];
}

export async function saveHostConflicts(
  projectPath: string,
  conflicts: OfflineConflict[],
): Promise<void> {
  await idbSet(hostConflictKey(projectPath), conflicts);
}

export async function clearHostConflicts(projectPath: string): Promise<void> {
  await saveHostConflicts(projectPath, []);
}

export async function addHostConflict(
  projectPath: string,
  conflict: OfflineConflict,
): Promise<void> {
  await updateStoredList<OfflineConflict, void>(
    hostConflictKey(projectPath),
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
