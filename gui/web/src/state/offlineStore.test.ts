import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addHostConflict,
  enqueueHostCommand,
  loadCommandQueue,
  loadConflicts,
  loadHostCommandCount,
  loadHostCommandQueue,
  loadHostConflicts,
  type QueuedCommand,
  removeHostConflictsWhere,
  removeHostQueuedCommands,
} from "./offlineStore";

const command: QueuedCommand = {
  client_id: "original-tab",
  command_id: "saved-edit",
  client_seq: 7,
  type: "FutureCommand",
  payload: { value: "kept" },
  created_at: 12,
};
const conflict = { command, reason: "" };
const rows = new Map<string, unknown>();
let closed = 0;
let putFailure: { value: unknown } | undefined;
let constructionFailure: "transaction" | "get" | undefined;

function database() {
  return {
    close() {
      closed++;
    },
    transaction() {
      if (constructionFailure === "transaction")
        throw new Error("transaction failed");
      let aborted = false;
      const writes = new Map<string, unknown>();
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
              if (constructionFailure === "get") throw new Error("get failed");
              const req = {
                result: structuredClone(rows.get(key)),
                onsuccess: () => {},
              };
              queueMicrotask(() => {
                req.onsuccess();
                queueMicrotask(() => {
                  if (aborted) return;
                  for (const [key, value] of writes) rows.set(key, value);
                  tx.oncomplete();
                });
              });
              return req;
            },
            put(value: unknown, key: string) {
              if (putFailure) throw putFailure.value;
              writes.set(key, structuredClone(value));
            },
          };
        },
      };
      return tx;
    },
  };
}

beforeEach(() => {
  rows.clear();
  closed = 0;
  putFailure = undefined;
  constructionFailure = undefined;
  vi.stubGlobal("indexedDB", {
    open() {
      const req = { result: database(), onsuccess: () => {} };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const loaders = [
  {
    key: "queue:bucket",
    load: () => loadCommandQueue("bucket"),
    item: command,
  },
  {
    key: "host-queue:bucket",
    load: () => loadHostCommandQueue("bucket"),
    item: command,
  },
  {
    key: "conflicts:bucket",
    load: () => loadConflicts("bucket"),
    item: conflict,
  },
  {
    key: "host-conflicts:bucket",
    load: () => loadHostConflicts("bucket"),
    item: conflict,
  },
];

describe("durable list admission", () => {
  it.each(loaders)(
    "admits current $key records and rejects missing nested identity in full",
    async ({ key, load, item }) => {
      await expect(load()).resolves.toEqual([]);
      rows.set(key, [item, item]);
      await expect(load()).resolves.toEqual([item, item]);
      const { client_id: _identity, ...retired } = command;
      const invalid = key.includes("conflicts")
        ? { command: retired, reason: "refused" }
        : retired;
      const mixed = [item, invalid, item];
      rows.set(key, mixed);
      await expect(load()).rejects.toThrow("Invalid saved command");
      expect(rows.get(key)).toEqual(mixed);
      for (const root of [null, {}, "rows", [null]]) {
        rows.set(key, root);
        await expect(load()).rejects.toThrow(/Invalid saved/);
        expect(rows.get(key)).toEqual(root);
      }
    },
  );

  it.each([
    { client_id: "" },
    { command_id: "" },
    { client_seq: 0 },
    { client_seq: 1.5 },
    { client_seq: Number.MAX_SAFE_INTEGER + 1 },
    { payload: [] },
    { payload: null },
    { created_at: Number.NaN },
    { type: "" },
    { structural_mode: null },
    { structural_mode: "other" },
    { source_anchor: null },
    { source_anchor: { source_sec: Number.POSITIVE_INFINITY } },
    { source_anchor: { source_sec: 1, clip_id: 2 } },
  ])(
    "rejects malformed declared fields %j without rewriting",
    async (patch) => {
      const raw = [{ ...command, ...patch }];
      rows.set("queue:bucket", raw);
      await expect(loadCommandQueue("bucket")).rejects.toThrow(
        /Invalid saved command/,
      );
      expect(rows.get("queue:bucket")).toEqual(raw);
      rows.set("queue:bucket", [
        {
          ...command,
          source_anchor: { source_sec: -1, clip_id: "" },
          structural_mode: undefined,
        },
      ]);
      await expect(loadCommandQueue("bucket")).resolves.toEqual([
        { ...command, source_anchor: { source_sec: -1, clip_id: "" } },
      ]);
    },
  );

  it("counts only an admitted queue and leaves stale cached entries untouched", async () => {
    rows.set("host-queue-count:bucket", 0);
    rows.set("host-queue:bucket", [command]);
    await expect(loadHostCommandCount("bucket")).resolves.toBe(1);
    rows.set("host-queue-count:bucket", 99);
    rows.set("host-queue:bucket", []);
    await expect(loadHostCommandCount("bucket")).resolves.toBe(0);
    rows.set("host-queue:bucket", [command, null]);
    await expect(loadHostCommandCount("bucket")).rejects.toThrow(
      "Invalid saved command",
    );
    expect(rows.get("host-queue-count:bucket")).toBe(99);
  });
});

const routes = [
  {
    key: "host-queue:bucket",
    item: command,
    run: () => enqueueHostCommand("bucket", command),
    expected: [command],
  },
  {
    key: "host-queue:bucket",
    item: command,
    run: () => removeHostQueuedCommands("bucket", [command.command_id]),
    expected: [],
  },
  {
    key: "host-conflicts:bucket",
    item: conflict,
    run: () => addHostConflict("bucket", conflict),
    expected: [conflict],
  },
  {
    key: "host-conflicts:bucket",
    item: conflict,
    run: () => removeHostConflictsWhere("bucket", () => true),
    expected: [],
  },
];

describe("transaction admission and settlement", () => {
  it.each(routes)(
    "rejects $key mutation atomically and allows the next operation",
    async ({ key, item, run, expected }) => {
      const raw = [item, null, item];
      rows.set(key, raw);
      rows.set("host-queue-count:bucket", 99);
      await expect(run()).rejects.toThrow(/Invalid saved/);
      expect(rows.get(key)).toEqual(raw);
      expect(rows.get("host-queue-count:bucket")).toBe(99);
      expect(closed).toBe(1);
      rows.set(key, [item]);
      await run();
      expect(rows.get(key)).toEqual(expected);
      expect(closed).toBe(2);
    },
  );

  it.each([undefined, null, new Error("original update cause")])(
    "preserves an updater's exact thrown value %s",
    async (cause) => {
      rows.set("host-conflicts:bucket", [conflict]);
      await expect(
        removeHostConflictsWhere("bucket", () => {
          throw cause;
        }),
      ).rejects.toBe(cause);
      expect(rows.get("host-conflicts:bucket")).toEqual([conflict]);
      await removeHostConflictsWhere("bucket", () => false);
      expect(await loadHostConflicts("bucket")).toEqual([conflict]);
    },
  );

  it.each([undefined, null, new Error("original put cause")])(
    "preserves a put's exact thrown value %s and releases its host lock",
    async (cause) => {
      rows.set("host-queue:bucket", [command]);
      putFailure = { value: cause };
      await expect(
        enqueueHostCommand("bucket", { ...command, command_id: "next" }),
      ).rejects.toBe(cause);
      expect(rows.get("host-queue:bucket")).toEqual([command]);
      putFailure = undefined;
      await enqueueHostCommand("bucket", { ...command, command_id: "next" });
      expect(await loadHostCommandQueue("bucket")).toEqual([
        command,
        { ...command, command_id: "next" },
      ]);
    },
  );

  it.each(["transaction", "get"] as const)(
    "closes after synchronous %s construction failure",
    async (failure) => {
      constructionFailure = failure;
      await expect(enqueueHostCommand("bucket", command)).rejects.toThrow(
        `${failure} failed`,
      );
      expect(closed).toBe(1);
      constructionFailure = undefined;
      await enqueueHostCommand("bucket", command);
      expect(await loadHostCommandQueue("bucket")).toEqual([command]);
    },
  );
});
