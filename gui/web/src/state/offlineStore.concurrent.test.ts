import { afterEach, expect, it, vi } from "vitest";
import {
  enqueueCommand,
  loadCommandQueue,
  type QueuedCommand,
  removeQueuedCommand,
  saveCommandQueue,
} from "./offlineStore";

afterEach(() => vi.unstubAllGlobals());

it("retains an admitted ordinary edit while completed guest history is removed", async () => {
  const rows = new Map<string, unknown>();
  let transactions = Promise.resolve();
  vi.stubGlobal("indexedDB", {
    open() {
      const req = {
        result: {
          close() {},
          transaction() {
            let release!: () => void;
            const prior = transactions;
            transactions = new Promise<void>((resolve) => {
              release = resolve;
            });
            const operations: (() => void)[] = [];
            const tx = {
              oncomplete: () => {},
              onabort: () => {},
              onerror: () => {},
              objectStore: () => ({
                get(key: string) {
                  const read = {
                    result: undefined as unknown,
                    onsuccess: () => {},
                  };
                  operations.push(() => {
                    read.result = structuredClone(rows.get(key));
                    read.onsuccess();
                  });
                  return read;
                },
                put(value: unknown, key: string) {
                  operations.push(() => rows.set(key, structuredClone(value)));
                },
              }),
            };
            void prior.then(() => {
              for (const operation of operations) operation();
              tx.oncomplete();
              release();
            });
            return tx;
          },
        },
        onsuccess: () => {},
      };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  });
  const history: QueuedCommand = {
    client_id: "guest",
    command_id: "H",
    client_seq: 1,
    type: "UndoHistory",
    payload: {},
    created_at: 1,
  };
  const edit: QueuedCommand = {
    ...history,
    command_id: "B",
    client_seq: 2,
    type: "SetTrackMeta",
    payload: { name: "kept" },
  };
  await saveCommandQueue("guest", [history]);
  await Promise.all([
    enqueueCommand("guest", edit),
    removeQueuedCommand("guest", "H"),
    removeQueuedCommand("guest", "completed-A"),
  ]);
  expect(await loadCommandQueue("guest")).toEqual([edit]);
});
