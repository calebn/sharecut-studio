import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadHostCommandQueue = vi.fn();
const enqueueHostCommand = vi.fn();
const removeHostQueuedCommand = vi.fn();
const addHostConflict = vi.fn();
const enqueueCommand = vi.fn();
const removeQueuedCommand = vi.fn();
const addConflict = vi.fn();
const applyDocumentResult = vi.fn();
const requestHostDrain = vi.fn();

const applyDocumentSnapshot = vi.fn();

vi.mock("./document/applyDocumentUpdate", () => ({
  applyDocumentResult,
  applyDocumentSnapshot,
  mergeGuestActionDone: vi.fn(),
  mergeReturnedComment: vi.fn(),
}));

vi.mock("./state/drainOfflineQueue", () => ({ requestHostDrain }));

vi.mock("./state/hostSendOrder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/hostSendOrder")>()),
  HOST_SEND_WAIT_MS: 200,
}));

vi.mock("./state/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand,
  addHostConflict,
  enqueueCommand,
  removeQueuedCommand,
  addConflict,
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

  describe("live sends behind this tab's in-flight send", () => {
    const path = "/tmp/episode.project.json";
    const refine409 = () =>
      new Response(JSON.stringify({ detail: "Refine required" }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
      });

    it("surfaces the typed 409 when the command waits behind an in-flight send", async () => {
      let releaseFirst!: () => void;
      const fetchSpy = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              releaseFirst = () => resolve(new Response("{}", { status: 200 }));
            }),
        )
        .mockImplementationOnce(async () => refine409());
      vi.stubGlobal("fetch", fetchSpy);
      enqueueHostCommand
        .mockReset()
        .mockImplementation(
          async (_path: string, cmd: { command_id: string }) => ({
            persisted: true,
            hadPredecessor: cmd.command_id === "second",
          }),
        );
      loadHostCommandQueue.mockResolvedValue([
        { command_id: "second", payload: { ids: ["a"] } },
      ]);
      const { submitDocumentCommand } = await import("./api");
      const first = submitDocumentCommand(
        path,
        "SetTrackMeta",
        {},
        {
          command_id: "first",
        },
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const second = submitDocumentCommand(
        path,
        "ApproveEdits",
        { ids: ["a"] },
        {
          command_id: "second",
        },
      );
      const assertion = expect(second).rejects.toMatchObject({
        code: "transcript_refine_required",
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      releaseFirst();
      await first;
      await assertion;
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(requestHostDrain).not.toHaveBeenCalled();
    });

    it("stays queued and requests a drain when the earlier send stalls", async () => {
      let releaseFirst!: () => void;
      const fetchSpy = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              releaseFirst = () => resolve(new Response("{}", { status: 200 }));
            }),
        )
        .mockImplementation(async () => {
          throw new Error("unexpected second post");
        });
      vi.stubGlobal("fetch", fetchSpy);
      enqueueHostCommand
        .mockReset()
        .mockImplementation(
          async (_path: string, cmd: { command_id: string }) => ({
            persisted: true,
            hadPredecessor: cmd.command_id === "second",
          }),
        );
      const { submitDocumentCommand } = await import("./api");
      const first = submitDocumentCommand(
        path,
        "SetTrackMeta",
        {},
        { command_id: "first" },
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const result = await submitDocumentCommand(
        path,
        "ApproveEdits",
        { ids: ["a"] },
        { command_id: "second" },
      );
      expect(result).toMatchObject({ queued: true, command_id: "second" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(requestHostDrain).toHaveBeenCalledWith(path),
      );
      // Finish the stalled send so it does not linger in the shared registry.
      releaseFirst();
      await first;
    });

    it("stays queued and requests a drain when the queue is unreadable after waiting", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: true,
      });
      loadHostCommandQueue.mockRejectedValue(new Error("idb"));
      const { submitDocumentCommand } = await import("./api");
      const result = await submitDocumentCommand(
        path,
        "SetTrackMeta",
        {},
        { command_id: "mine" },
      );
      expect(result.queued).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(requestHostDrain).toHaveBeenCalledWith(path),
      );
    });

    it("stays queued behind real leftovers", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: true,
      });
      loadHostCommandQueue.mockResolvedValue([
        { command_id: "old", payload: {} },
        { command_id: "mine", payload: {} },
      ]);
      const { submitDocumentCommand } = await import("./api");
      const result = await submitDocumentCommand(
        path,
        "SetTrackMeta",
        {},
        {
          command_id: "mine",
        },
      );
      expect(result.queued).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(requestHostDrain).toHaveBeenCalledWith(path),
      );
    });

    it("posts the chained payload from the persisted record", async () => {
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: true,
      });
      loadHostCommandQueue.mockResolvedValue([
        { command_id: "mine", payload: { chained: true } },
      ]);
      const { submitDocumentCommand } = await import("./api");
      await submitDocumentCommand(
        path,
        "SetTrackMeta",
        { chained: false },
        {
          command_id: "mine",
        },
      );
      const init = (
        fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      )[1];
      expect(JSON.parse(init.body as string).payload).toEqual({
        chained: true,
      });
    });
  });

  describe("guest queue outcomes", () => {
    const fader = { track_id: "host", fader_db: -3 };
    const queuedId = () =>
      (enqueueCommand.mock.calls[0]?.[1] as { command_id: string }).command_id;

    it("drops a live command the server refused, so it never replays", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("slow down", { status: 429 })),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader),
      ).rejects.toThrow();
      expect(removeQueuedCommand).toHaveBeenCalledWith("tok", queuedId());
      expect(addConflict).not.toHaveBeenCalled();
    });

    it("keeps a rate-limited replay queued for the next drain", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("slow down", { status: 429 })),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader, {
          replaying: true,
        }),
      ).rejects.toThrow();
      expect(removeQueuedCommand).not.toHaveBeenCalled();
      expect(addConflict).not.toHaveBeenCalled();
    });

    it("records a refused replay before dropping it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("no edit", { status: 403 })),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader, {
          replaying: true,
        }),
      ).rejects.toThrow();
      expect(addConflict).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({ reason: "no edit" }),
      );
      expect(removeQueuedCommand).toHaveBeenCalledWith("tok", queuedId());
    });

    it("keeps a command whose request never arrived queued, not failed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("network down");
        }),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader),
      ).resolves.toMatchObject({ queued: true });
      expect(removeQueuedCommand).not.toHaveBeenCalled();
    });

    it("doesn't apply a reply after the guest switched projects", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
      );
      const { submitDocumentCommand } = await import("./api");
      const { useDawStore } = await import("./state/dawStore");
      useDawStore.setState({ projectPath: "share:other" });

      await submitDocumentCommand("share:tok", "SetTrackFader", fader);
      expect(applyDocumentResult).not.toHaveBeenCalled();
      useDawStore.setState({ projectPath: "" });
    });
  });

  it("persists a guest edit before posting its command identity", async () => {
    const calls: string[] = [];
    enqueueCommand.mockImplementation(async () => {
      calls.push("enqueue");
    });
    const queuedId = "guest-command";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push("fetch");
        const body = JSON.parse(init.body as string);
        expect(body.role).toBe("guest");
        expect(body.command_id).toBe(queuedId);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    await submitDocumentCommand(
      "share:tok",
      "SetTrackFader",
      {},
      {
        command_id: queuedId,
        client_seq: 8,
      },
    );
    expect(calls).toEqual(["enqueue", "fetch"]);
    expect(removeQueuedCommand).toHaveBeenCalledWith("tok", queuedId);
  });

  it("keeps a host replay queued after a server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 503 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand(
        "/tmp/episode.project.json",
        "SetTrackMeta",
        {},
        {
          command_id: "replay-command",
          client_seq: 9,
          replaying: true,
        },
      ),
    ).resolves.toMatchObject({ queued: true, command_id: "replay-command" });
    expect(enqueueHostCommand).not.toHaveBeenCalled();
    expect(removeHostQueuedCommand).not.toHaveBeenCalled();
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
