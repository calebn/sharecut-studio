import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadHostCommandQueue = vi.fn();
const enqueueHostCommand = vi.fn();
const removeHostQueuedCommand = vi.fn();
const addHostConflict = vi.fn();
const enqueueCommand = vi.fn();
const applyDocumentResult = vi.fn();

vi.mock("./document/applyDocumentUpdate", () => ({
  applyDocumentResult,
  mergeGuestActionDone: vi.fn(),
  mergeReturnedComment: vi.fn(),
}));

vi.mock("./state/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand,
  addHostConflict,
  enqueueCommand,
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

  it("accepts queued comment creation and patches without a false failure", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { createComment, patchComment } = await import("./api");

    await expect(
      createComment("/tmp/episode.project.json", {
        body: "Review note",
        author: "Host",
        timelineStart: 2,
      }),
    ).resolves.toBeNull();
    await expect(
      patchComment("/tmp/episode.project.json", "comment-1", {
        resolved: true,
      }),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("binds a legacy guest queue record to the current tab identity on replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
    const { submitDocumentCommand } = await import("./api");

    await submitDocumentCommand(
      "share:legacy",
      "SetTrackMeta",
      {},
      {
        command_id: "legacy-command",
        client_seq: 7,
      },
    );

    expect(enqueueCommand).toHaveBeenCalledWith(
      "legacy",
      expect.objectContaining({
        command_id: "legacy-command",
        client_seq: 7,
        client_id: expect.stringMatching(/^viewer-/),
      }),
    );
  });

  it("does not post a newer edit when storage failure hides an older one", async () => {
    enqueueHostCommand.mockRejectedValue(new Error("quota exceeded"));
    loadHostCommandQueue.mockResolvedValue([{ command_id: "older" }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).rejects.toThrow("older offline edits are pending");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not report a committed edit as failed when queue cleanup fails", async () => {
    removeHostQueuedCommand.mockRejectedValue(new Error("storage unavailable"));
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

  it("does not apply a stale response after switching projects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, snapshot: { comments: [] } }),
            {
              status: 200,
            },
          ),
      ),
    );
    const { useDawStore } = await import("./state/dawStore");
    useDawStore.setState({ projectPath: "/tmp/project-b.json" });
    const { submitDocumentCommand } = await import("./api");

    await submitDocumentCommand("/tmp/project-a.json", "SetTrackMeta");

    expect(applyDocumentResult).not.toHaveBeenCalled();
    useDawStore.setState({ projectPath: "" });
  });

  it("still applies a response for the active project", async () => {
    const snapshot = { comments: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, snapshot }), { status: 200 }),
      ),
    );
    const { useDawStore } = await import("./state/dawStore");
    useDawStore.setState({ projectPath: "/tmp/project-a.json" });
    const { submitDocumentCommand } = await import("./api");

    await submitDocumentCommand("/tmp/project-a.json", "SetTrackMeta");

    expect(applyDocumentResult).toHaveBeenCalledWith({ ok: true, snapshot });
    useDawStore.setState({ projectPath: "" });
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
