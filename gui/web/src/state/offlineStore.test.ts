import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addConflict,
  addHostConflict,
  clearConflicts,
  clearHostConflicts,
  enqueueCommand,
  enqueueHostCommand,
  loadCommandQueue,
  loadConflicts,
  loadHostCommandCount,
  loadHostCommandQueue,
  loadHostConflicts,
  type QueuedCommand,
  removeHostConflictsWhere,
  removeHostQueuedCommands,
  saveCommandQueue,
  saveConflicts,
  saveHostConflicts,
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
let abortedTransactions = 0;
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
      let reading = false;
      const writes = new Map<string, unknown>();
      const tx = {
        error: null,
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        abort() {
          aborted = true;
          abortedTransactions++;
          queueMicrotask(() => tx.onabort());
        },
        objectStore() {
          return {
            get(key: string) {
              reading = true;
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
              if (!reading)
                queueMicrotask(() => {
                  if (aborted) return;
                  for (const [key, value] of writes) rows.set(key, value);
                  tx.oncomplete();
                });
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
  abortedTransactions = 0;
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

const clears = [
  {
    key: "conflicts:bucket",
    clear: () => clearConflicts("bucket"),
    load: () => loadConflicts("bucket"),
  },
  {
    key: "host-conflicts:bucket",
    clear: () => clearHostConflicts("bucket"),
    load: () => loadHostConflicts("bucket"),
  },
];

describe("conflict clearing admission", () => {
  it.each(clears)(
    "retains malformed roots and mixed nested records in $key",
    async ({ key, clear, load }) => {
      const { client_id: _identity, ...retired } = command;
      const sparse = [conflict];
      sparse.length = 3;
      sparse[2] = conflict;
      for (const raw of [
        null,
        {},
        "conflicts",
        [conflict, null],
        [conflict, { command: retired, reason: "unseen" }],
        sparse,
      ]) {
        const beforeClose = closed;
        const beforeAbort = abortedTransactions;
        rows.set(key, raw);
        await expect(clear()).rejects.toThrow(/Invalid saved/);
        expect(rows.get(key)).toEqual(raw);
        expect(closed).toBe(beforeClose + 1);
        expect(abortedTransactions).toBe(beforeAbort + 1);
        rows.set(key, [conflict]);
        await clear();
        await expect(load()).resolves.toEqual([]);
        rows.set(key, [conflict]);
        await expect(load()).resolves.toEqual([conflict]);
      }
      rows.delete(key);
      await clear();
      await expect(load()).resolves.toEqual([]);
    },
  );

  it.each(clears)(
    "preserves exact put failures in $key and permits subsequent clear",
    async ({ key, clear, load }) => {
      for (const cause of [undefined, null, new Error("clear put failed")]) {
        rows.set(key, [conflict]);
        putFailure = { value: cause };
        await expect(clear()).rejects.toBe(cause);
        expect(rows.get(key)).toEqual([conflict]);
        putFailure = undefined;
        await clear();
        await expect(load()).resolves.toEqual([]);
        rows.set(key, [conflict]);
        await expect(load()).resolves.toEqual([conflict]);
      }
    },
  );
  it.each(clears)(
    "closes and releases failed transaction construction in $key",
    async ({ key, clear, load }) => {
      for (const failure of ["transaction", "get"] as const) {
        rows.set(key, [conflict]);
        const beforeClose = closed;
        constructionFailure = failure;
        await expect(clear()).rejects.toThrow(`${failure} failed`);
        expect(rows.get(key)).toEqual([conflict]);
        expect(closed).toBe(beforeClose + 1);
        constructionFailure = undefined;
        await clear();
        await expect(load()).resolves.toEqual([]);
        rows.set(key, [conflict]);
        await expect(load()).resolves.toEqual([conflict]);
      }
    },
  );

  it.each(clears)(
    "keeps its existing no-storage behavior for $key",
    async ({ clear, load }) => {
      vi.stubGlobal("indexedDB", undefined);
      await expect(clear()).resolves.toBeUndefined();
      await expect(load()).resolves.toEqual([]);
      expect(closed).toBe(0);
    },
  );
});

describe("canonical new write admission", () => {
  it.each([
    {
      key: "queue:bucket",
      save: (value: QueuedCommand) => saveCommandQueue("bucket", [value]),
    },
    {
      key: "queue:bucket",
      save: (value: QueuedCommand) => enqueueCommand("bucket", value),
    },
    {
      key: "host-queue:bucket",
      save: (value: QueuedCommand) => enqueueHostCommand("bucket", value),
    },
    {
      key: "conflicts:bucket",
      save: (value: QueuedCommand) =>
        saveConflicts("bucket", [{ command: value, reason: "" }]),
    },
    {
      key: "conflicts:bucket",
      save: (value: QueuedCommand) =>
        addConflict("bucket", { command: value, reason: "" }),
    },
    {
      key: "host-conflicts:bucket",
      save: (value: QueuedCommand) =>
        saveHostConflicts("bucket", [{ command: value, reason: "" }]),
    },
    {
      key: "host-conflicts:bucket",
      save: (value: QueuedCommand) =>
        addHostConflict("bucket", { command: value, reason: "" }),
    },
  ])(
    "rejects invalid new records in $key without replacing old raw data",
    async ({ key, save }) => {
      const old = key.includes("conflicts") ? [conflict] : [command];
      for (const patch of [
        { client_id: "" },
        { command_id: "" },
        { client_seq: Number.NaN },
        { client_seq: Number.MAX_SAFE_INTEGER + 1 },
        { payload: [] },
        { created_at: Infinity },
        { structural_mode: "wrong" },
        { source_anchor: { source_sec: Infinity } },
      ]) {
        rows.set(key, structuredClone(old));
        await expect(
          save({ ...command, ...patch } as unknown as QueuedCommand),
        ).rejects.toThrow(/Invalid saved/);
        expect(rows.get(key)).toEqual(old);
      }
    },
  );

  it("validates transformed host output before put and releases the transaction and lock", async () => {
    const baseline = await import("./queuedEnvelopeBaseline");
    const chain = vi
      .spyOn(baseline, "chainQueuedEnvelopeBaseline")
      .mockReturnValueOnce({
        ...command,
        command_id: "new",
        client_seq: Number.NaN,
      });
    try {
      rows.set("host-queue:bucket", [command]);
      const persistenceFailure = vi.fn();
      await expect(
        enqueueHostCommand(
          "bucket",
          { ...command, command_id: "new" },
          persistenceFailure,
        ),
      ).rejects.toThrow(/Invalid saved/);
      expect(rows.get("host-queue:bucket")).toEqual([command]);
      expect(abortedTransactions).toBe(1);
      expect(closed).toBe(1);
      expect(persistenceFailure).not.toHaveBeenCalled();
      await enqueueHostCommand("bucket", { ...command, command_id: "new" });
      expect(rows.get("host-queue:bucket")).toEqual([
        command,
        { ...command, command_id: "new" },
      ]);
    } finally {
      chain.mockRestore();
    }
  });
});

describe("host persistence failure signal", () => {
  it("signals only admitted put failures and preserves exact causes", async () => {
    for (const cause of [undefined, null, new Error("put failed")]) {
      rows.set("host-queue:bucket", []);
      const signal = vi.fn();
      putFailure = { value: cause };
      await expect(enqueueHostCommand("bucket", command, signal)).rejects.toBe(
        cause,
      );
      expect(signal).toHaveBeenCalledTimes(1);
      expect(rows.get("host-queue:bucket")).toEqual([]);
      putFailure = undefined;
      await enqueueHostCommand("bucket", command);
      expect(rows.get("host-queue:bucket")).toEqual([command]);
    }
  });
  it("never signals invalid input, unreadable rows or construction failures", async () => {
    const signal = vi.fn();
    await expect(
      enqueueHostCommand(
        "bucket",
        { ...command, client_seq: Number.NaN },
        signal,
      ),
    ).rejects.toThrow(/Invalid saved/);
    rows.set("host-queue:bucket", [null]);
    await expect(enqueueHostCommand("bucket", command, signal)).rejects.toThrow(
      /Invalid saved/,
    );
    expect(rows.get("host-queue:bucket")).toEqual([null]);
    rows.set("host-queue:bucket", []);
    for (const failure of ["transaction", "get"] as const) {
      constructionFailure = failure;
      await expect(
        enqueueHostCommand("bucket", command, signal),
      ).rejects.toThrow(`${failure} failed`);
    }
    constructionFailure = undefined;
    expect(signal).not.toHaveBeenCalled();
  });
  it("never signals an open failure before admission", async () => {
    const cause = new Error("open failed");
    vi.stubGlobal("indexedDB", {
      open() {
        const req = { error: cause, onerror: () => {} };
        queueMicrotask(() => req.onerror());
        return req;
      },
    });
    const signal = vi.fn();
    await expect(enqueueHostCommand("bucket", command, signal)).rejects.toBe(
      cause,
    );
    expect(signal).not.toHaveBeenCalled();
  });
});
