import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOfflineSnapshot } from "./offlineStore";

afterEach(() => vi.unstubAllGlobals());

type FakeTx = {
  oncomplete: () => void;
  onabort: () => void;
  onerror: () => void;
  error: Error | null;
  objectStore: () => { delete: (key: string) => void };
};

function stubIndexedDb(options: {
  fail?: boolean;
  throwOnTransaction?: boolean;
}) {
  const deleted: string[] = [];
  const close = vi.fn();
  vi.stubGlobal("indexedDB", {
    open() {
      const req: Record<string, unknown> = {
        result: {
          close,
          transaction() {
            if (options.throwOnTransaction) {
              throw new Error("transaction failed");
            }
            const tx: FakeTx = {
              oncomplete: () => {},
              onabort: () => {},
              onerror: () => {},
              error: options.fail ? new Error("aborted") : null,
              objectStore: () => ({
                delete: (key: string) => {
                  deleted.push(key);
                  queueMicrotask(() =>
                    options.fail ? tx.onabort() : tx.oncomplete(),
                  );
                },
              }),
            };
            return tx;
          },
        },
      };
      queueMicrotask(() => (req.onsuccess as () => void)());
      return req;
    },
  });
  return { deleted, close };
}

describe("clearOfflineSnapshot", () => {
  it("deletes the token's snapshot and closes the connection", async () => {
    const idb = stubIndexedDb({});
    await clearOfflineSnapshot("tok");
    expect(idb.deleted).toEqual(["snap:tok"]);
    expect(idb.close).toHaveBeenCalledOnce();
  });

  it("resolves for a token with no snapshot", async () => {
    stubIndexedDb({});
    await expect(clearOfflineSnapshot("missing")).resolves.toBeUndefined();
  });

  it("rejects when the transaction aborts and still closes", async () => {
    const idb = stubIndexedDb({ fail: true });
    await expect(clearOfflineSnapshot("tok")).rejects.toThrow("aborted");
    expect(idb.close).toHaveBeenCalledOnce();
  });

  it("closes the connection when opening the transaction throws", async () => {
    const idb = stubIndexedDb({ throwOnTransaction: true });
    await expect(clearOfflineSnapshot("tok")).rejects.toThrow(
      "transaction failed",
    );
    expect(idb.close).toHaveBeenCalledOnce();
  });
});
