import { vi } from "vitest";

/** A one-store IndexedDB that keeps rows in `rows`, enough for the offline stores' read-modify-write. */
export function stubIndexedDb(rows: Map<string, unknown>): void {
  const database = () => ({
    close() {},
    transaction() {
      const writes = new Map<string, unknown>();
      let reading = false;
      let aborted = false;
      const tx = {
        error: null,
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        abort() {
          aborted = true;
          queueMicrotask(() => tx.onabort());
        },
        objectStore() {
          return {
            get(key: string) {
              reading = true;
              const req = {
                result: structuredClone(rows.get(key)),
                onsuccess: () => {},
              };
              queueMicrotask(() => {
                req.onsuccess();
                queueMicrotask(() => {
                  if (aborted) return;
                  for (const [k, value] of writes) rows.set(k, value);
                  tx.oncomplete();
                });
              });
              return req;
            },
            put(value: unknown, key: string) {
              writes.set(key, structuredClone(value));
              if (!reading) {
                queueMicrotask(() => {
                  if (aborted) return;
                  for (const [k, v] of writes) rows.set(k, v);
                  tx.oncomplete();
                });
              }
            },
          };
        },
      };
      return tx;
    },
  });
  vi.stubGlobal("indexedDB", {
    open() {
      const req = { result: database(), onsuccess: () => {} };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  });
}
