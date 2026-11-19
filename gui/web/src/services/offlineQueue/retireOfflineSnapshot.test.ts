import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markLinkEnded } from "../../api/linkState";
import {
  loadOfflineSnapshot,
  mergeOfflineSnapshot,
  retireOfflineSnapshot,
  saveOfflineSnapshot,
} from "./offlineStore";

const rows = new Map<string, unknown>();
/** Held write transactions: each completes when its gate opens. */
let gate: Promise<void> = Promise.resolve();
let failOpen = false;

function database() {
  return {
    close() {},
    transaction(_store: string, mode: string) {
      const tx = {
        error: null,
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        objectStore() {
          return {
            get(key: string) {
              const req = {
                result: structuredClone(rows.get(key)),
                onsuccess: () => {},
              };
              queueMicrotask(() => {
                req.onsuccess();
                queueMicrotask(() => tx.oncomplete());
              });
              return req;
            },
            put(value: unknown, key: string) {
              const held = gate;
              void held.then(() => {
                rows.set(key, structuredClone(value));
                tx.oncomplete();
              });
            },
            delete(key: string) {
              rows.delete(key);
              queueMicrotask(() => tx.oncomplete());
            },
          };
        },
      };
      void mode;
      return tx;
    },
  };
}

beforeEach(() => {
  rows.clear();
  gate = Promise.resolve();
  failOpen = false;
  vi.stubGlobal("indexedDB", {
    open() {
      const req: {
        result?: unknown;
        onsuccess: () => void;
        onerror: () => void;
        error?: Error;
      } = {
        onsuccess: () => {},
        onerror: () => {},
      };
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error("denied");
          req.onerror();
        } else {
          req.result = database();
          req.onsuccess();
        }
      });
      return req;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("retireOfflineSnapshot", () => {
  it("deletes the saved copy", async () => {
    await saveOfflineSnapshot("r-plain", { project: { a: 1 }, saved_at: 1 });
    expect(await loadOfflineSnapshot("r-plain")).toBeDefined();
    await retireOfflineSnapshot("r-plain");
    expect(await loadOfflineSnapshot("r-plain")).toBeUndefined();
  });

  it("waits for a merge that had already begun, then deletes what it wrote", async () => {
    let open: () => void = () => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const merging = mergeOfflineSnapshot("r-wait", { project: { a: 2 } });
    let retired = false;
    const retiring = retireOfflineSnapshot("r-wait").then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    open();
    await merging;
    await retiring;
    expect(rows.has("snap:r-wait")).toBe(false);
  });

  it("lets no write begin once the link ended, so nothing brings the copy back", async () => {
    markLinkEnded("r-late");
    await saveOfflineSnapshot("r-late", { project: {}, saved_at: 1 });
    await mergeOfflineSnapshot("r-late", { project: {} });
    expect(rows.has("snap:r-late")).toBe(false);
  });

  it("does not reject when the store will not open", async () => {
    failOpen = true;
    await expect(retireOfflineSnapshot("r-down")).resolves.toBeUndefined();
  });

  it("leaves the queued edits and conflicts alone", async () => {
    rows.set("queue:r-keep", [{ command_id: "x" }]);
    rows.set("conflicts:r-keep", [{ kind: "refused" }]);
    rows.set("snap:r-keep", { saved_at: 1 });
    await retireOfflineSnapshot("r-keep");
    expect([...rows.keys()].sort()).toEqual([
      "conflicts:r-keep",
      "queue:r-keep",
    ]);
  });
});
