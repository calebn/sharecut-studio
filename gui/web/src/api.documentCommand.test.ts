import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadHostCommandQueue = vi.fn();
const enqueueHostCommand = vi.fn();
const removeHostQueuedCommand = vi.fn();
const addHostConflict = vi.fn();

vi.mock("./state/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand,
  addHostConflict,
  enqueueCommand: vi.fn(),
  removeQueuedCommand: vi.fn(),
  addConflict: vi.fn(),
}));

describe("host document command queue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadHostCommandQueue.mockResolvedValue([]);
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    removeHostQueuedCommand.mockResolvedValue(undefined);
    addHostConflict.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists before posting and removes the identity after success", async () => {
    const calls: string[] = [];
    enqueueHostCommand.mockImplementation(async () => {
      calls.push("enqueue");
      return { persisted: true, hadPredecessor: false };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    const result = await submitDocumentCommand(
      "/tmp/episode.project.json",
      "SetTrackMeta",
      {
        label: "Host",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["enqueue", "fetch"]);
    expect(removeHostQueuedCommand).toHaveBeenCalledOnce();
  });

  it("returns queued for a server failure without losing the durable command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 503 })),
    );
    const { submitDocumentCommand } = await import("./api");

    const result = await submitDocumentCommand(
      "/tmp/episode.project.json",
      "SetTrackMeta",
    );

    expect(result.queued).toBe(true);
    expect(removeHostQueuedCommand).not.toHaveBeenCalled();
  });

  it("does not post behind an existing predecessor", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).resolves.toMatchObject({ queued: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects transport failure when storage could not persist", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: false,
      hadPredecessor: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).rejects.toThrow("offline");
  });

  it("replays with the original client identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(init.body as string).client_id).toBe("old-client");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    await submitDocumentCommand(
      "/tmp/episode.project.json",
      "SetTrackMeta",
      {},
      {
        client_id: "old-client",
        command_id: "command-1",
        client_seq: 4,
        replaying: true,
      },
    );
  });

  it("still posts online when IndexedDB persistence fails", async () => {
    enqueueHostCommand.mockRejectedValue(new Error("storage unavailable"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).resolves.toEqual({ ok: true });
  });

  it("records conflicts and removes them from retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("stale revision", { status: 409 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).rejects.toThrow("stale revision");
    expect(addHostConflict).toHaveBeenCalledOnce();
    expect(removeHostQueuedCommand).toHaveBeenCalledOnce();
  });
});
