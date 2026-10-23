import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addConflict,
  addHostConflict,
  clearConflicts,
  clearHostConflicts,
  dismissConflicts,
  dismissHostConflicts,
  enqueueCommand,
  enqueueHostCommand,
  loadCommandQueue,
  loadConflicts,
  loadGuestAttention,
  loadHostAttention,
  loadHostCommandCount,
  loadHostCommandQueue,
  loadHostConflicts,
  type QueuedCommand,
  removeHostConflictsWhere,
  removeHostQueuedCommands,
  saveCommandQueue,
  settleHostCommandOutcome,
} from "./offlineStore";

const command: QueuedCommand = {
  client_id: "original-tab",
  command_id: "saved-edit",
  client_seq: 7,
  type: "FutureCommand",
  payload: { value: "kept" },
  created_at: 12,
};
const conflict = {
  command,
  kind: "refused" as const,
  reason: "",
  recovery: "edit-and-resubmit" as const,
};
const rows = new Map<string, unknown>();
let closed = 0;
let abortedTransactions = 0;
let putFailure: { value: unknown } | undefined;
let constructionFailure: "transaction" | "get" | undefined;
let transactionCount = 0;

function database() {
  return {
    close() {
      closed++;
    },
    transaction() {
      transactionCount++;
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
  transactionCount = 0;
  vi.stubGlobal("indexedDB", {
    open() {
      const req = { result: database(), onsuccess: () => {} };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("dismissal transaction results", () => {
  const refusal = {
    ...conflict,
    command: { ...command, command_id: "refused" },
    reason: "Rejected edit.",
  };
  const historyCommand = {
    ...command,
    command_id: "history",
    type: "UndoHistory",
  };
  const history = {
    command: historyCommand,
    kind: "unknown" as const,
    reason: "Undo may have been applied.",
    recovery: "inspect-history" as const,
  };
  const unrelated = { ...command, command_id: "unrelated" };
  const hostQueue = "host-queue:/project";
  const hostConflicts = "host-conflicts:/project";
  const guestQueue = "queue:token";
  const guestConflicts = "conflicts:token";

  it.each([
    {
      name: "host",
      queueKey: hostQueue,
      conflictKey: hostConflicts,
      dismiss: () => dismissHostConflicts("/project", [refusal, history]),
      readAttention: () => loadHostAttention("/project"),
      readQueue: () => loadHostCommandQueue("/project"),
      otherQueueKey: guestQueue,
      otherConflictKey: guestConflicts,
      otherQueue: () => loadCommandQueue("token"),
      otherConflicts: () => loadConflicts("token"),
      pending: 2,
    },
    {
      name: "guest",
      queueKey: guestQueue,
      conflictKey: guestConflicts,
      dismiss: () => dismissConflicts("token", [refusal, history]),
      readAttention: () => loadGuestAttention("token"),
      readQueue: () => loadCommandQueue("token"),
      otherQueueKey: hostQueue,
      otherConflictKey: hostConflicts,
      otherQueue: () => loadHostCommandQueue("/project"),
      otherConflicts: () => loadHostConflicts("/project"),
      pending: 0,
    },
  ])(
    "returns the committed $name queue and conflict snapshot",
    async ({
      queueKey,
      conflictKey,
      dismiss,
      readAttention,
      readQueue,
      otherQueueKey,
      otherConflictKey,
      otherQueue,
      otherConflicts,
      pending,
    }) => {
      rows.set(queueKey, [refusal.command, unrelated, historyCommand]);
      rows.set(conflictKey, [refusal, history]);
      rows.set(otherQueueKey, [refusal.command, unrelated, historyCommand]);
      rows.set(otherConflictKey, [refusal, history]);
      const committedConflicts = [
        { ...refusal, dismissed: true },
        { ...history, dismissed: true },
      ];

      await expect(dismiss()).resolves.toEqual({
        pending,
        conflicts: committedConflicts,
      });
      await expect(readAttention()).resolves.toEqual({
        pending,
        conflicts: committedConflicts,
      });
      await expect(readQueue()).resolves.toEqual([unrelated, historyCommand]);
      await expect(otherQueue()).resolves.toEqual([
        refusal.command,
        unrelated,
        historyCommand,
      ]);
      await expect(otherConflicts()).resolves.toEqual([refusal, history]);
    },
  );
});

it("reads host pending work and its outcome from one IndexedDB snapshot", async () => {
  rows.set("host-queue:/project", [command]);
  rows.set("host-conflicts:/project", [conflict]);

  await expect(loadHostAttention("/project")).resolves.toEqual({
    pending: 1,
    conflicts: [conflict],
  });
  expect(transactionCount).toBe(1);
});

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
    { key: "conflicts:bucket", load: () => loadConflicts("bucket") },
    { key: "host-conflicts:bucket", load: () => loadHostConflicts("bucket") },
  ])(
    "does not infer a saved conflict outcome in $key",
    async ({ key, load }) => {
      const missingKind = [{ command, reason: "server failed" }];
      rows.set(key, missingKind);
      await expect(load()).rejects.toThrow("Invalid saved conflict outcome");
      expect(rows.get(key)).toEqual(missingKind);

      const missingRecovery = [{ ...conflict, recovery: undefined }];
      rows.set(key, missingRecovery);
      await expect(load()).rejects.toThrow("Invalid saved conflict outcome");
      expect(rows.get(key)).toEqual(missingRecovery);
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

describe("guest queue order", () => {
  const row = (
    id: string,
    clientId: string,
    seq: number,
    label = id,
  ): QueuedCommand => ({
    ...command,
    command_id: id,
    client_id: clientId,
    client_seq: seq,
    payload: { label },
  });

  it("appends across client ids and keeps a re-admitted row as it stands", async () => {
    await enqueueCommand("bucket", row("prior-9", "viewer-prior", 9));
    await enqueueCommand("bucket", row("prior-12", "viewer-prior", 12));
    await enqueueCommand("bucket", row("new-1", "viewer-new", 1));

    await enqueueCommand(
      "bucket",
      row("prior-9", "viewer-prior", 9, "re-admitted"),
    );

    const queue = await loadCommandQueue("bucket");
    expect(queue.map((c) => c.command_id)).toEqual([
      "prior-9",
      "prior-12",
      "new-1",
    ]);
    expect(queue[0].payload).toEqual({ label: "prior-9" });
  });
});

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

describe("dismissal transaction", () => {
  it("atomically retires a refused queue row while keeping terminal truth", async () => {
    rows.set("host-queue:bucket", [command]);
    rows.set("host-conflicts:bucket", [conflict]);

    await dismissHostConflicts("bucket", [conflict]);

    expect(rows.get("host-queue:bucket")).toEqual([]);
    expect(rows.get("host-conflicts:bucket")).toEqual([
      { ...conflict, dismissed: true },
    ]);
    await expect(loadHostAttention("bucket")).resolves.toEqual({
      pending: 0,
      conflicts: [{ ...conflict, dismissed: true }],
    });
  });

  it("keeps the save-blocking flag when a refusal is read back", async () => {
    const blocking = { ...conflict, blocksSave: true };
    rows.set("host-conflicts:bucket", [blocking]);
    expect(await loadHostConflicts("bucket")).toEqual([blocking]);
  });

  it("keeps the queue and refusal when either write in dismissal fails", async () => {
    rows.set("host-queue:bucket", [command]);
    rows.set("host-conflicts:bucket", [conflict]);
    const failure = new Error("dismiss write failed");
    putFailure = { value: failure };

    await expect(dismissHostConflicts("bucket", [conflict])).rejects.toBe(
      failure,
    );

    expect(rows.get("host-queue:bucket")).toEqual([command]);
    expect(rows.get("host-conflicts:bucket")).toEqual([conflict]);
  });

  it("retains hidden History state when replay reconciliation updates it", async () => {
    const history = {
      command: { ...command, type: "UndoHistory", payload: {} },
      kind: "unknown" as const,
      reason: "Undo may have applied",
      recovery: "inspect-history" as const,
      dismissed: true,
    };
    rows.set("host-queue:bucket", [history.command]);
    rows.set("host-conflicts:bucket", [history]);

    await settleHostCommandOutcome(
      "bucket",
      command.command_id,
      {
        ...history,
        reason: "Undo or Redo may have been applied. Check History.",
      },
      true,
    );

    expect(rows.get("host-queue:bucket")).toEqual([]);
    expect(rows.get("host-conflicts:bucket")).toEqual([
      {
        ...history,
        reason: "Undo or Redo may have been applied. Check History.",
      },
    ]);
  });
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
        addConflict("bucket", {
          command: value,
          kind: "refused",
          reason: "",
          recovery: "edit-and-resubmit",
        }),
    },
    {
      key: "host-conflicts:bucket",
      save: (value: QueuedCommand) =>
        addHostConflict("bucket", {
          command: value,
          kind: "refused",
          reason: "",
          recovery: "edit-and-resubmit",
        }),
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
