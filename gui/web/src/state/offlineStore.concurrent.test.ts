import { afterEach, expect, it, vi } from "vitest";
import {
  enqueueCommand,
  loadCommandQueue,
  type QueuedCommand,
  removeQueuedCommand,
  saveCommandQueue,
} from "./offlineStore";

afterEach(() => vi.unstubAllGlobals());

function stubSerializedIndexedDb(): void {
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
}

it("retains an admitted ordinary edit while completed guest history is removed", async () => {
  stubSerializedIndexedDb();
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

it("keeps a prior client's rows ahead of a new client's row admitted during their re-admission and cleanup", async () => {
  stubSerializedIndexedDb();
  const row = (id: string, clientId: string, seq: number): QueuedCommand => ({
    client_id: clientId,
    command_id: id,
    client_seq: seq,
    type: "SetTrackMeta",
    payload: { label: id },
    created_at: seq,
  });
  const prior = row("prior-9", "viewer-prior", 9);
  const completedHistory = {
    ...row("history", "viewer-prior", 12),
    type: "UndoHistory",
    payload: {},
  };
  const incoming = row("new-1", "viewer-new", 1);
  await saveCommandQueue("guest", [prior, completedHistory]);

  await Promise.all([
    enqueueCommand("guest", incoming),
    enqueueCommand("guest", prior),
    removeQueuedCommand("guest", "history"),
  ]);

  expect(
    (await loadCommandQueue("guest")).map((command) => command.command_id),
  ).toEqual(["prior-9", "new-1"]);
});
