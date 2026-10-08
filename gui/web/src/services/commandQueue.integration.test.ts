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
      expect(enqueueHostCommand).toHaveBeenCalledWith(path, {
        client_id: "live-client",
        command_id: "live-command",
        client_seq: 41,
        type: "SetTrackMeta",
        payload: { label: "Live" },
        structural_mode: undefined,
        created_at: expect.any(Number),
      });
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
