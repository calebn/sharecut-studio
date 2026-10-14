import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addConflict,
  addHostConflict,
  enqueueCommand,
  loadCommandQueue,
  loadConflicts,
  loadHostConflicts,
  type OfflineConflict,
  type QueuedCommand,
  removeConflictsWhere,
  removeHostConflictsWhere,
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

const refused = (id: string, label = id): OfflineConflict => ({
  command: {
    client_id: "guest",
    command_id: id,
    client_seq: 1,
    type: "SetTrackMeta",
    payload: { label },
    created_at: 1,
  },
  kind: "refused",
  reason: `refused ${id}`,
  recovery: "edit-and-resubmit",
});

const ids = (conflicts: OfflineConflict[]) =>
  conflicts.map((conflict) => conflict.command.command_id);

const namespaces = [
  {
    name: "guest",
    add: (conflict: OfflineConflict) => addConflict("ns", conflict),
    removeWhere: (p: (conflict: OfflineConflict) => boolean) =>
      removeConflictsWhere("ns", p),
    load: () => loadConflicts("ns"),
  },
  {
    name: "host",
    add: (conflict: OfflineConflict) => addHostConflict("ns", conflict),
    removeWhere: (p: (conflict: OfflineConflict) => boolean) =>
      removeHostConflictsWhere("ns", p),
    load: () => loadHostConflicts("ns"),
  },
];

describe.each(namespaces)(
  "$name conflicts list",
  ({ add, removeWhere, load }) => {
    it("keeps a refused edit added while a superseded entry is removed", async () => {
      stubSerializedIndexedDb();
      await add(refused("old-correction"));
      await Promise.all([
        removeWhere((c) => c.command.command_id === "old-correction"),
        add(refused("new-409")),
      ]);
      expect(ids(await load())).toEqual(["new-409"]);
    });

    it("keeps both entries of two concurrent adds and one of a repeated command", async () => {
      stubSerializedIndexedDb();
      await Promise.all([
        add(refused("first")),
        add(refused("second")),
        add(refused("second", "again")),
      ]);
      const kept = await load();
      expect(ids(kept).sort()).toEqual(["first", "second"]);
      expect(
        kept.find((c) => c.command.command_id === "second")?.command.payload,
      ).toEqual({ label: "again" });
    });
  },
);
