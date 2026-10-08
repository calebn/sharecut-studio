import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueHostCommand = vi.fn();
const enqueueCommand = vi.fn();
const loadHostCommandQueue = vi.fn();

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("../state/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand: vi.fn(),
  enqueueCommand,
  removeQueuedCommand: vi.fn(),
}));

describe("queued command identity and landed history", () => {
  const path = "/tmp/episode.project.json";

  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    loadHostCommandQueue.mockResolvedValue([]);
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
      "../state/hostSendOrder"
    );
    const mark = savesLandedMark(path);
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
    expect(headLandedSince(path, mark)).toBe("h-replay-9");
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
        "../state/hostSendOrder"
      );
      const mark = savesLandedMark(path);
      const result = await submitDocumentCommand(path, "SetTrackMeta", {});
      expect(result.ok).toBe(true);
      expect(headLandedSince(path, mark)).toBeNull();
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
      "../state/hostSendOrder"
    );
    const mark = savesLandedMark(path);
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
    expect(headLandedSince(path, mark)).toBeNull();
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
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    loadHostCommandQueue.mockResolvedValue([]);
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
      const { savesLandedMark } = await import("../state/hostSendOrder");
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
});
