import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadHostCommandQueue = vi.fn();
const enqueueHostCommand = vi.fn();
const removeHostQueuedCommand = vi.fn();
const addHostConflict = vi.fn();
const enqueueCommand = vi.fn();
const applyDocumentResult = vi.fn();

const applyDocumentSnapshot = vi.fn();

vi.mock("./document/applyDocumentUpdate", () => ({
  applyDocumentResult,
  applyDocumentSnapshot,
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

  it("records a rejected replay so a dropped queued edit is visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("expected_points missing", { status: 422 }),
      ),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand(
        "/tmp/episode.project.json",
        "SetEnvelope",
        {},
        { command_id: "legacy", client_seq: 1, replaying: true },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(addHostConflict).toHaveBeenCalledWith(
      "/tmp/episode.project.json",
      expect.objectContaining({ reason: "expected_points missing" }),
    );
    expect(removeHostQueuedCommand).toHaveBeenCalledWith(
      "/tmp/episode.project.json",
      "legacy",
    );
  });

  it("does not add a banner row for a live 4xx the caller already shows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad payload", { status: 422 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.project.json", "SetTrackMeta"),
    ).rejects.toThrow("bad payload");
    expect(addHostConflict).not.toHaveBeenCalled();
  });

  it("shows a queued envelope edit so the next edit builds on it", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    vi.stubGlobal("fetch", vi.fn());
    const { useDawStore } = await import("./state/dawStore");
    const { minimalProject } = await import("./test/fixtures");
    const pan = { track_id: "host", parameter: "pan", points: [] };
    useDawStore.getState().hydrate(
      "/tmp/episode.project.json",
      minimalProject({
        envelopes: [
          pan,
          {
            track_id: "host",
            parameter: "volume",
            points: [{ id: "a", time: 0, value: 1 }],
          },
        ],
      }),
    );
    const { setEnvelope } = await import("./api");
    const next = [{ id: "a", time: 0, value: 0.5 }];

    await setEnvelope("/tmp/episode.project.json", "host", next, [
      { id: "a", time: 0, value: 1 },
    ]);

    expect(useDawStore.getState().project?.envelopes).toEqual([
      pan,
      { track_id: "host", parameter: "volume", points: next },
    ]);
    useDawStore.setState({ projectPath: "", project: null });
  });

  it("reloads the host envelope slice after a SetEnvelope conflict", async () => {
    const envelopes = [{ track_id: "host", parameter: "volume", points: [] }];
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes("phase=envelopes")
        ? new Response(JSON.stringify({ envelopes }), { status: 200 })
        : new Response(JSON.stringify({ detail: { detail: "changed" } }), {
            status: 409,
          }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { useDawStore } = await import("./state/dawStore");
    useDawStore.setState({ projectPath: "/tmp/episode.project.json" });
    const { setEnvelope } = await import("./api");

    await expect(
      setEnvelope("/tmp/episode.project.json", "host", [], []),
    ).rejects.toThrow("changed");
    expect(applyDocumentSnapshot).toHaveBeenCalledWith(
      { patch: { envelopes } },
      { force: true },
    );
    useDawStore.setState({ projectPath: "" });
  });
});
