import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";

const enqueueHostCommand = vi.fn();
const enqueueCommand = vi.fn();
const loadHostCommandQueue = vi.fn();
const removeHostQueuedCommand = vi.fn();
const settleHostCommandOutcome = vi.fn();
const settleGuestCommandOutcome = vi.fn();
let persistedHostCommands: { command_id: string; type: string }[] = [];

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("../state/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand,
  settleHostCommandOutcome,
  settleGuestCommandOutcome,
  enqueueCommand,
  removeQueuedCommand: vi.fn(),
}));

describe("queued command identity and landed history", () => {
  const path = "/tmp/episode.project.json";

  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    persistedHostCommands = [];
    enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    loadHostCommandQueue.mockImplementation(async () => [
      ...persistedHostCommands,
    ]);
    enqueueHostCommand.mockImplementation(
      async (_path: string, command: { command_id: string; type: string }) => {
        const hadPredecessor =
          command.type === "UndoHistory" || command.type === "RedoHistory"
            ? persistedHostCommands.length > 0
            : false;
        persistedHostCommands.push(command);
        return { persisted: true, hadPredecessor };
      },
    );
    removeHostQueuedCommand.mockImplementation(
      async (_path: string, commandId: string) => {
        persistedHostCommands = persistedHostCommands.filter(
          (command) => command.command_id !== commandId,
        );
      },
    );
    settleHostCommandOutcome.mockImplementation(
      async (_path, commandId, _outcome, remove) => {
        if (remove)
          persistedHostCommands = persistedHostCommands.filter(
            (command) => command.command_id !== commandId,
          );
      },
    );
    settleGuestCommandOutcome.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function laggingHistory() {
    const api = await import("../api");
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    const { clearRegisteredCommands, execute } = await import(
      "../commands/execute"
    );
    const { _resetHistoryMovesForTests, registerHistoryCommands } =
      await import("../commands/history");
    const project = minimalProject();
    useDawStore.setState({
      projectPath: path,
      project: {
        ...project,
        history: { ...project.history, can_undo: true, can_redo: true },
      },
    });
    authority.resetDocumentAuthority(path);
    authority.documentAuthority.seq = 1;
    clearRegisteredCommands();
    _resetHistoryMovesForTests();
    registerHistoryCommands();
    return { api, execute, useDawStore, ...authority };
  }

  it("uses completed command replies through undo and redo while display lags", async () => {
    const { api, execute, useDawStore } = await laggingHistory();
    const replies = [
      { ok: true, server_seq: 4, history_head_id: "after-host-approval" },
      {
        ok: true,
        snapshot: { server_seq: 5 },
        history_head_id: "before-approval",
      },
      { ok: true, server_seq: 6, history_head_id: "before-earlier-edit" },
      { ok: true, server_seq: 7, history_head_id: "before-approval" },
    ];
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(replies.shift()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await api.submitDocumentCommand(path, "ApproveEdits", {
      ids: ["range-proposal"],
    });
    expect(useDawStore.getState().project?.history.head_id).toBe("root");
    expect(await execute("history.undo")).toEqual({ status: "ok" });
    expect(await execute("history.undo")).toEqual({ status: "ok" });
    expect(await execute("history.redo")).toEqual({ status: "ok" });
    expect(
      fetchSpy.mock.calls.slice(1).map((call) => {
        const init = (call as unknown as [string, RequestInit])[1];
        const body = JSON.parse(init.body as string);
        return { type: body.type, payload: body.payload };
      }),
    ).toEqual([
      {
        type: "UndoHistory",
        payload: { rerender: false, expected_head_id: "after-host-approval" },
      },
      {
        type: "UndoHistory",
        payload: { rerender: false, expected_head_id: "before-approval" },
      },
      {
        type: "RedoHistory",
        payload: { rerender: false, expected_head_id: "before-earlier-edit" },
      },
    ]);
  });

  it.each(["undo", "redo"])(
    "expires a completed own move before %s when newer recovery starts",
    async (action) => {
      const {
        api,
        execute,
        documentAuthority,
        ownCommandHead,
        documentScope,
        useDawStore,
      } = await laggingHistory();
      const replies = [
        { ok: true, server_seq: 4, history_head_id: "after-host-approval" },
        { ok: true, server_seq: 5, history_head_id: "before-approval" },
        { ok: true },
      ];
      const fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify(replies.shift()), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      await api.submitDocumentCommand(path, "ApproveEdits", {
        ids: ["range-proposal"],
      });
      expect(await execute("history.undo")).toEqual({ status: "ok" });
      documentAuthority.phase = { kind: "recovering", minimum: 6 };
      expect(
        ownCommandHead(
          documentScope(),
          useDawStore.getState().project?.history.head_id ?? null,
        ),
      ).toBeNull();
      expect(await execute(`history.${action}`)).toEqual({ status: "ok" });
      const init = (
        fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit]
      )[1];
      expect(JSON.parse(init.body as string).payload).toEqual({
        rerender: false,
        expected_head_id: "root",
      });
    },
  );

  it.each(["undo", "redo"])(
    "refuses an obsolete waiting %s and ignores its save receipt after reopening",
    async (action) => {
      const { api, execute, resetDocumentAuthority, useDawStore } =
        await laggingHistory();
      let release!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchSpy = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const save = api.submitDocumentCommand(path, "ApproveEdits", {
        ids: ["old-scope"],
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const obsolete = execute(`history.${action}`);
      resetDocumentAuthority(path);
      const current = execute(`history.${action}`);
      release(
        new Response(
          JSON.stringify({
            ok: true,
            server_seq: 4,
            history_head_id: "old-scope-head",
          }),
          { status: 200 },
        ),
      );
      await save;
      const reason =
        action === "undo"
          ? "Can't undo: the project changed since. Nothing was undone."
          : "Can't redo: the project changed since. Nothing was redone.";
      expect(await obsolete).toEqual({
        status: "disabled",
        reason,
      });
      expect(await current).toEqual({ status: "ok" });
      expect(useDawStore.getState().statusAnnouncement).toBe(reason);
      expect(
        fetchSpy.mock.calls
          .slice(1)
          .map(
            (call) =>
              JSON.parse(
                (call as unknown as [string, RequestInit])[1].body as string,
              ).payload,
          ),
      ).toEqual([{ rerender: false, expected_head_id: "root" }]);
    },
  );

  it.each(["newer-reply", "applied-peer", "reopened"])(
    "ignores a late own receipt after %s",
    async (advance) => {
      const { api, execute, documentAuthority, resetDocumentAuthority } =
        await laggingHistory();
      let release!: (response: Response) => void;
      const late = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchSpy = vi
        .fn()
        .mockReturnValueOnce(late)
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const old = api.submitDocumentCommand(path, "ApproveEdits", {
        ids: ["old"],
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      let expected = "root";
      if (advance === "newer-reply") {
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              server_seq: 4,
              history_head_id: "newer-own-head",
            }),
            { status: 200 },
          ),
        );
        await api.submitDocumentCommand(path, "ApproveEdits", {
          ids: ["newer"],
        });
        expected = "newer-own-head";
      } else if (advance === "applied-peer") documentAuthority.seq = 4;
      else resetDocumentAuthority(path);
      release(
        new Response(
          JSON.stringify({
            ok: true,
            server_seq: 2,
            history_head_id: "obsolete-own-head",
          }),
          { status: 200 },
        ),
      );
      await old;
      expect(await execute("history.undo")).toEqual({ status: "ok" });
      const init = (
        fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit]
      )[1];
      expect(JSON.parse(init.body as string).payload).toEqual({
        rerender: false,
        expected_head_id: expected,
      });
    },
  );

  it("reports an unknown history outcome and keeps the observed head for a later press", async () => {
    const { api, execute } = await laggingHistory();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            server_seq: 2,
            history_head_id: "after-host-approval",
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    await api.submitDocumentCommand(path, "ApproveEdits", {
      ids: ["range-proposal"],
    });
    await expect(execute("history.undo")).rejects.toThrow(
      "Undo or Redo may have been applied. Check History before trying again.",
    );
    expect(await execute("history.undo")).toEqual({ status: "ok" });
    expect(
      fetchSpy.mock.calls.slice(1).map((call) => {
        const init = (call as unknown as [string, RequestInit])[1];
        return JSON.parse(init.body as string).payload;
      }),
    ).toEqual([
      { rerender: false, expected_head_id: "after-host-approval" },
      { rerender: false, expected_head_id: "after-host-approval" },
    ]);
  });

  it("records a replay's landed head while posting its original identity", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, history_head_id: "h-replay-9" }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("../api");
    const { headLandedSince, savesLandedMark } = await import(
      "../state/documentSendOrder"
    );
    const mark = savesLandedMark(path);
    const scope = (await import("../document/authorityState")).documentScope();
    const result = await submitDocumentCommand(
      path,
      "SetTrackMeta",
      { label: "Restored" },
      {
        replaying: true,
        client_id: "original-client",
        command_id: "original-command",
        client_seq: 9,
        structural_mode: "apply",
      },
    );
    const init = (
      fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "original-client",
      command_id: "original-command",
      client_seq: 9,
      structural_mode: "apply",
      type: "SetTrackMeta",
      payload: { label: "Restored" },
      role: "viewer",
    });
    expect(result).toEqual({ ok: true, history_head_id: "h-replay-9" });
    expect(headLandedSince(path, mark, scope)).toBe("h-replay-9");
  });

  it("allocates live defaults once and posts the identity it persisted", async () => {
    const identity = await import("../utils/documentClient");
    const commandId = vi
      .spyOn(identity, "newCommandId")
      .mockReturnValue("live-command");
    const clientId = vi
      .spyOn(identity, "documentClientId")
      .mockReturnValue("live-client");
    const sequence = vi
      .spyOn(identity, "nextDocumentClientSeq")
      .mockReturnValueOnce(41)
      .mockReturnValue(42);
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, history_head_id: "h-live-41" }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { submitDocumentCommand } = await import("../api");
      const result = await submitDocumentCommand(path, "SetTrackMeta", {
        label: "Live",
      });
      const init = (
        fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      )[1];
      expect(JSON.parse(init.body as string)).toEqual({
        client_id: "live-client",
        command_id: "live-command",
        client_seq: 41,
        type: "SetTrackMeta",
        payload: { label: "Live" },
        role: "viewer",
      });
      expect(enqueueHostCommand).toHaveBeenCalledWith(
        path,
        {
          client_id: "live-client",
          command_id: "live-command",
          client_seq: 41,
          type: "SetTrackMeta",
          payload: { label: "Live" },
          structural_mode: undefined,
          created_at: expect.any(Number),
        },
        expect.any(Function),
      );
      expect(result).toEqual({ ok: true, history_head_id: "h-live-41" });
      const queued = enqueueHostCommand.mock.calls[0]?.[1];
      await submitDocumentCommand(path, queued.type, queued.payload, {
        replaying: true,
        client_id: queued.client_id,
        command_id: queued.command_id,
        client_seq: queued.client_seq,
      });
      const replayInit = (
        fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
      )[1];
      expect(JSON.parse(replayInit.body as string)).toEqual({
        client_id: "live-client",
        command_id: "live-command",
        client_seq: 41,
        type: "SetTrackMeta",
        payload: { label: "Live" },
        role: "viewer",
      });
      expect(sequence).toHaveBeenCalledTimes(1);
      expect(commandId).toHaveBeenCalledTimes(1);
      expect(clientId).toHaveBeenCalledTimes(1);
    } finally {
      sequence.mockRestore();
      commandId.mockRestore();
      clientId.mockRestore();
    }
  });

  it.each([undefined, null, "", 7, {}, []])(
    "does not record an absent or invalid history head %j",
    async (historyHead) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ ok: true, history_head_id: historyHead }),
              { status: 200 },
            ),
        ),
      );
      const { submitDocumentCommand } = await import("../api");
      const { headLandedSince, savesLandedMark } = await import(
        "../state/documentSendOrder"
      );
      const mark = savesLandedMark(path);
      const scope = (
        await import("../document/authorityState")
      ).documentScope();
      const result = await submitDocumentCommand(path, "SetTrackMeta", {});
      expect(result.ok).toBe(true);
      expect(headLandedSince(path, mark, scope)).toBeNull();
      expect(savesLandedMark(path)).toBe(mark);
    },
  );

  it("keeps an unreadable queue pending without recording a landed head", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    loadHostCommandQueue.mockRejectedValue(new Error("IndexedDB unreadable"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("../api");
    const { headLandedSince, savesLandedMark } = await import(
      "../state/documentSendOrder"
    );
    const mark = savesLandedMark(path);
    const scope = (await import("../document/authorityState")).documentScope();
    const result = await submitDocumentCommand(
      path,
      "SetTrackMeta",
      {},
      {
        command_id: "unreadable-command",
        client_id: "unreadable-client",
        client_seq: 12,
      },
    );
    expect(result).toEqual({
      ok: true,
      queued: true,
      command_id: "unreadable-command",
      client_seq: 12,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(headLandedSince(path, mark, scope)).toBeNull();
    expect(savesLandedMark(path)).toBe(mark);
  });

  it("uses the current tab identity for a live command with explicit id and sequence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
    const { submitDocumentCommand } = await import("../api");

    await submitDocumentCommand(
      "share:live",
      "SetTrackMeta",
      {},
      {
        command_id: "live-command",
        client_seq: 7,
      },
    );

    expect(enqueueCommand).toHaveBeenCalledWith(
      "live",
      expect.objectContaining({
        command_id: "live-command",
        client_seq: 7,
        client_id: expect.stringMatching(/^viewer-/),
      }),
    );
  });
});

describe("live identity admission before side effects", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    loadHostCommandQueue.mockResolvedValue([]);
    enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["/identity-host", "share:identity-guest"])(
    "rejects a malformed generated counter for %s without draft, persistence or transport",
    async (path) => {
      sessionStorage.setItem("daw_document_client_seq", "NaN");
      const fetchSpy = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const drafts = await import("../document/pendingDrafts");
      const draft = vi.spyOn(drafts, "beginDocumentDraft");
      const { useDawStore } = await import("../state/dawStore");
      useDawStore.setState({ projectPath: path });
      const { savesLandedMark } = await import("../state/documentSendOrder");
      const mark = savesLandedMark(path);
      const { submitQueuedDocumentCommand } = await import("./commandQueue");
      await expect(
        submitQueuedDocumentCommand(path, "SetTrackMeta", {}),
      ).rejects.toThrow();
      expect(sessionStorage.getItem("daw_document_client_seq")).toBe("NaN");
      expect(draft).not.toHaveBeenCalled();
      expect(enqueueHostCommand).not.toHaveBeenCalled();
      expect(enqueueCommand).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(savesLandedMark(path)).toBe(mark);
    },
  );

  it.each(["/identity-host", "share:identity-guest"])(
    "rejects supplied invalid identity in %s before allocating defaults",
    async (path) => {
      const fetchSpy = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const identity = await import("../utils/documentClient");
      const commandId = vi.spyOn(identity, "newCommandId");
      const sequence = vi.spyOn(identity, "nextDocumentClientSeq");
      const clientId = vi.spyOn(identity, "documentClientId");
      const { submitQueuedDocumentCommand } = await import("./commandQueue");
      const invalid = [
        { client_id: "" },
        { client_id: null },
        { client_id: 7 },
        { command_id: "" },
        { command_id: null },
        { command_id: 7 },
        ...[
          0,
          -1,
          1.5,
          Number.NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
          null,
        ].map((client_seq) => ({ client_seq })),
      ];
      for (const patch of invalid) {
        await expect(
          submitQueuedDocumentCommand(
            path,
            "SetTrackMeta",
            {},
            patch as unknown as import("./commandQueue").DocumentCommandOptions,
          ),
        ).rejects.toThrow();
        expect(commandId).not.toHaveBeenCalled();
        expect(sequence).not.toHaveBeenCalled();
        expect(clientId).not.toHaveBeenCalled();
        expect(enqueueHostCommand).not.toHaveBeenCalled();
        expect(enqueueCommand).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
  );

  it("retains direct send for valid identity when persistence fails and queue is readable and empty", async () => {
    const cause = new Error("storage unavailable");
    enqueueHostCommand.mockImplementation(
      async (
        _path: string,
        _command: unknown,
        onPersistenceFailure: () => void,
      ) => {
        onPersistenceFailure();
        throw cause;
      },
    );
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { submitQueuedDocumentCommand } = await import("./commandQueue");
    await expect(
      submitQueuedDocumentCommand(
        "/fallback",
        "SetTrackMeta",
        {},
        { client_id: "tab", command_id: "edit", client_seq: 7 },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      client_id: "tab",
      command_id: "edit",
      client_seq: 7,
      type: "SetTrackMeta",
      payload: {},
      role: "viewer",
    });
  });
  it("does not send after an enqueue rejection without a persistence signal", async () => {
    const cause = new Error("rejected row");
    enqueueHostCommand.mockRejectedValue(cause);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitQueuedDocumentCommand } = await import("./commandQueue");
    await expect(
      submitQueuedDocumentCommand(
        "/rejected",
        "SetTrackMeta",
        {},
        {
          client_id: "tab",
          command_id: "edit",
          client_seq: 7,
        },
      ),
    ).rejects.toBe(cause);
    expect(loadHostCommandQueue).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("rejects invalid allocator output and incomplete replay before side effects", async () => {
    const identity = await import("../utils/documentClient");
    const sequence = vi
      .spyOn(identity, "nextDocumentClientSeq")
      .mockReturnValue(Number.NaN);
    const clientId = vi.spyOn(identity, "documentClientId");
    const commandId = vi.spyOn(identity, "newCommandId");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const drafts = await import("../document/pendingDrafts");
    const draft = vi.spyOn(drafts, "beginDocumentDraft");
    const { submitQueuedDocumentCommand } = await import("./commandQueue");
    await expect(
      submitQueuedDocumentCommand(
        "/resolved",
        "SetTrackMeta",
        {},
        {
          client_id: "tab",
          command_id: "edit",
        },
      ),
    ).rejects.toThrow("Invalid document command identity");
    expect(sequence).toHaveBeenCalledTimes(1);
    sequence.mockClear();
    await expect(
      submitQueuedDocumentCommand("/resolved", "SetTrackMeta", {}, {
        replaying: true,
        command_id: "edit",
        client_seq: 7,
      } as unknown as import("./commandQueue").DocumentCommandOptions),
    ).rejects.toThrow("Invalid document command identity");
    expect(sequence).not.toHaveBeenCalled();
    expect(clientId).not.toHaveBeenCalled();
    expect(commandId).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    expect(enqueueHostCommand).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    [
      "ReorderTrack",
      { track_id: "b", index: 0 },
      (ids: string[], _labels: string[]) => expect(ids).toEqual(["b", "a"]),
    ],
    [
      "SetTrackMeta",
      { track_id: "a", label: "New" },
      (_ids: string[], labels: string[]) =>
        expect(labels).toEqual(["New", "B"]),
    ],
  ])(
    "begins the %s draft before its first await, so redisplayDrafts shows it at once",
    async (type, payload, expectShown) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => undefined)),
      );
      const { useDawStore } = await import("../state/dawStore");
      const { minimalProject, sampleTrack } = await import("../test/fixtures");
      const { overlayDocumentDrafts } = await import(
        "../document/pendingDrafts"
      );
      const project = minimalProject({
        tracks: [
          sampleTrack({ id: "a", label: "A" }),
          sampleTrack({ id: "b", label: "B" }),
        ],
      });
      useDawStore.getState().hydrate("/resolved", project);
      const { submitQueuedDocumentCommand } = await import("./commandQueue");
      void submitQueuedDocumentCommand("/resolved", type, payload);
      const shown = overlayDocumentDrafts(project);
      expectShown(
        shown.tracks.map((t) => t.id),
        shown.tracks.map((t) => t.label),
      );
    },
  );
});
