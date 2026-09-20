/** Minimal IndexedDB helpers for offline snapshot + command queue. */

const DB_NAME = "podcast-daw-offline";
const DB_VERSION = 1;
const STORE = "kv";

export interface QueuedCommand {
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
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function queueKey(token: string): string {
  return `queue:${token}`;
}

function snapKey(token: string): string {
  return `snap:${token}`;
}

function conflictKey(token: string): string {
  return `conflicts:${token}`;
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
  const queue = await loadCommandQueue(token);
  queue.push(cmd);
  await saveCommandQueue(token, queue);
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
