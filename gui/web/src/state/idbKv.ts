const DB_NAME = "podcast-daw-offline";
const DB_VERSION = 1;
export const STORE = "kv";

export function openDb(): Promise<IDBDatabase> {
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

export async function idbGet<T>(key: string): Promise<T | undefined> {
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

export async function idbSet(key: string, value: unknown): Promise<void> {
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

export async function updateStoredList<Item, Result>(
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
