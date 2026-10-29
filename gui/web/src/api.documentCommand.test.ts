import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadHostCommandQueue = vi.fn();
const enqueueHostCommand = vi.fn();
const removeHostQueuedCommand = vi.fn();
const addHostConflict = vi.fn();
const settleHostCommandOutcome = vi.fn();
const settleGuestCommandOutcome = vi.fn();
const enqueueCommand = vi.fn();
const removeQueuedCommand = vi.fn();
const addConflict = vi.fn();
const applyDocumentResult = vi.fn();
const requestHostDrain = vi.fn();

const applyDocumentSnapshot = vi.fn();

const redisplayDrafts = vi.fn();

vi.mock("./document/applyDocumentUpdate", () => ({
  applyDocumentResult,
  applyDocumentSnapshot,
  redisplayDrafts,
  refreshDocumentDisplay: vi.fn(),
  mergeGuestActionDone: vi.fn(),
  mergeReturnedComment: vi.fn(),
}));

vi.mock("./services/offlineQueue/drainOfflineQueue", () => ({
  requestHostDrain,
}));

vi.mock("./state/documentSendOrder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/documentSendOrder")>()),
  DOCUMENT_SEND_WAIT_MS: 200,
}));

vi.mock("./services/offlineQueue/offlineStore", () => ({
  loadHostCommandQueue,
  enqueueHostCommand,
  removeHostQueuedCommand,
  addHostConflict,
  settleHostCommandOutcome,
  settleGuestCommandOutcome,
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
    enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    removeHostQueuedCommand.mockResolvedValue(undefined);
    addHostConflict.mockResolvedValue(undefined);
    settleHostCommandOutcome.mockResolvedValue(undefined);
    settleGuestCommandOutcome.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the captured fade baseline before a durable wait and replays it unchanged", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            detail:
              "This clip changed. Nothing was saved. Adjust the fade again.",
          }),
          {
            status: 409,
            headers: { "X-Sharecut-Error-Code": "clip_fade_changed" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { setClipFade, submitDocumentCommand } = await import("./api");
    const expected = { fade_in_ms: 1, fade_out_ms: 0 };
    await setClipFade("/tmp/episode.sharecut", "c1", 1, 1, expected);
    expected.fade_in_ms = 0;
    const command = enqueueHostCommand.mock.calls[0][1] as {
      command_id: string;
      client_id: string;
      client_seq: number;
      payload: Record<string, unknown>;
    };
    expect(command.payload).toEqual({
      clip_id: "c1",
      fade_in_ms: 1,
      fade_out_ms: 1,
      expected: { fade_in_ms: 1, fade_out_ms: 0 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      submitDocumentCommand(
        "/tmp/episode.sharecut",
        "SetClipFade",
        command.payload,
        { ...command, replaying: true },
      ),
    ).rejects.toMatchObject({ code: "clip_fade_changed", status: 409 });
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      payload: unknown;
    };
    expect(body.payload).toEqual({
      clip_id: "c1",
      fade_in_ms: 1,
      fade_out_ms: 1,
      expected: { fade_in_ms: 1, fade_out_ms: 0 },
    });
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      command.command_id,
      expect.objectContaining({
        kind: "refused",
        reason: "This clip changed. Nothing was saved. Adjust the fade again.",
        command: expect.objectContaining({ payload: command.payload }),
      }),
      true,
    );
  });

  it("rejects with the model a host 409 model_needed names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: {
                detail: "Needs the noise model.",
                model: {
                  id: "rnnoise",
                  model: "rnnoise",
                  label: "RNNoise",
                  purpose: "Reduces noise",
                  size: "1 MB",
                  size_bytes: 1_000_000,
                  command: "podcast bootstrap",
                  state: "missing",
                },
              },
            }),
            {
              status: 409,
              headers: { "X-Sharecut-Error-Code": "model_needed" },
            },
          ),
      ),
    );
    const { submitDocumentCommand } = await import("./api");
    const { isModelNeeded } = await import("./utils/apiError");
    const error = await submitDocumentCommand(
      "/tmp/episode.sharecut",
      "AddEffect",
      { clip_id: "c1" },
      { replaying: true, command_id: "fx", client_id: "host", client_seq: 1 },
    ).catch((e: unknown) => e);
    expect(isModelNeeded(error)).toBe(true);
    expect((error as { model: { id: string } }).model.id).toBe("rnnoise");
  });

  it("retains the captured guest fade pair on refused replay", async () => {
    const payload = {
      clip_id: "c1",
      fade_in_ms: 1,
      fade_out_ms: 1,
      expected: { fade_in_ms: 1, fade_out_ms: 0 },
    };
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ detail: "Adjust the fade again." }), {
          status: 409,
          headers: { "X-Sharecut-Error-Code": "clip_fade_changed" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("./api");
    await expect(
      submitDocumentCommand("share:fade", "SetClipFade", payload, {
        replaying: true,
        command_id: "saved-fade",
        client_id: "guest",
        client_seq: 8,
      }),
    ).rejects.toMatchObject({ code: "clip_fade_changed", status: 409 });
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject(
      {
        command_id: "saved-fade",
        client_id: "guest",
        client_seq: 8,
        payload,
      },
    );
    expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
      "fade",
      "saved-fade",
      expect.objectContaining({
        kind: "refused",
        command: expect.objectContaining({ payload }),
        reason: "Adjust the fade again.",
      }),
      true,
    );
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
      createComment("/tmp/episode.sharecut", {
        body: "Review note",
        author: "Host",
        timelineStart: 2,
      }),
    ).resolves.toBeNull();
    await expect(
      patchComment("/tmp/episode.sharecut", "comment-1", {
        resolved: true,
      }),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("the history head a command's reply left", () => {
    const path = "/tmp/episode.sharecut";

    it("is recorded for a landed command, so an Undo behind it expects it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: true, history_head_id: "h-7" }), {
              status: 200,
            }),
        ),
      );
      const { submitDocumentCommand } = await import("./api");
      const { headLandedSince, savesLandedMark } = await import(
        "./state/documentSendOrder"
      );
      const mark = savesLandedMark(path);
      const scope = (await import("./document/authorityState")).documentScope();
      await submitDocumentCommand(path, "TrimClipEdge", {});
      expect(headLandedSince(path, mark, scope)).toBe("h-7");
    });

    it("is not recorded for a command that only queued", async () => {
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: false,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("offline");
        }),
      );
      const { submitDocumentCommand } = await import("./api");
      const { headLandedSince, savesLandedMark } = await import(
        "./state/documentSendOrder"
      );
      const mark = savesLandedMark(path);
      const scope = (await import("./document/authorityState")).documentScope();
      const result = await submitDocumentCommand(path, "TrimClipEdge", {});
      expect(result).toMatchObject({ queued: true });
      expect(headLandedSince(path, mark, scope)).toBeNull();
    });
  });

  describe("live sends behind this tab's in-flight send", () => {
    const path = "/tmp/episode.sharecut";
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

    it("waits for the drain pass in progress before re-reading the queue head", async () => {
      const { trackDocumentDrain } = await import("./state/documentSendOrder");
      let finishDrain!: () => void;
      trackDocumentDrain(
        path,
        new Promise<void>((r) => {
          finishDrain = r;
        }),
      );
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: true,
      });
      let queue = [
        { command_id: "replayed", payload: {} },
        { command_id: "mine", payload: { ids: ["a"] } },
      ];
      loadHostCommandQueue.mockImplementation(async () => queue);
      const fetchSpy = vi.fn(async () => refine409());
      vi.stubGlobal("fetch", fetchSpy);
      const { submitDocumentCommand } = await import("./api");
      const pending = submitDocumentCommand(
        path,
        "ApproveEdits",
        { ids: ["a"] },
        { command_id: "mine" },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: "transcript_refine_required",
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      queue = [{ command_id: "mine", payload: { ids: ["a"] } }];
      finishDrain();
      await assertion;
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    it("records the chained payload it sent when the server refuses it", async () => {
      enqueueHostCommand.mockResolvedValue({
        persisted: true,
        hadPredecessor: true,
      });
      loadHostCommandQueue.mockResolvedValue([
        { command_id: "mine", payload: { chained: true } },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => refine409()),
      );
      const { submitDocumentCommand } = await import("./api");
      await expect(
        submitDocumentCommand(
          path,
          "SetEnvelope",
          { chained: false },
          {
            command_id: "mine",
            client_id: "original-client",
            client_seq: 7,
            structural_mode: "apply",
          },
        ),
      ).rejects.toBeTruthy();
      expect(settleHostCommandOutcome).toHaveBeenCalledWith(
        path,
        "mine",
        expect.objectContaining({
          kind: "refused",
          command: expect.objectContaining({
            command_id: "mine",
            client_id: "original-client",
            client_seq: 7,
            structural_mode: "apply",
            payload: { chained: true },
          }),
        }),
        true,
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
    const queuedId = () => {
      expect(enqueueCommand).toHaveBeenCalled();
      const command = enqueueCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Expected an admitted guest command");
      return command.command_id;
    };

    it("applies a committed guest reply even when local queue cleanup fails", async () => {
      const { useDawStore } = await import("./state/dawStore");
      const { minimalProject } = await import("./test/fixtures");
      useDawStore.getState().hydrate("share:tok", minimalProject());
      removeQueuedCommand.mockRejectedValueOnce(
        new Error("IndexedDB unavailable"),
      );
      const reply = {
        ok: true,
        snapshot: { server_seq: 2, project: minimalProject() },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 })),
      );
      const { submitDocumentCommand } = await import("./api");
      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader),
      ).resolves.toEqual(reply);
      expect(applyDocumentResult).toHaveBeenCalledWith(
        reply,
        expect.objectContaining({ path: "share:tok" }),
      );
    });

    it.each([429, 503])(
      "keeps a live guest command with unknown outcome %i for same-id replay",
      async (status) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("slow down", { status })),
        );
        const { submitDocumentCommand } = await import("./api");

        await expect(
          submitDocumentCommand("share:tok", "SetTrackFader", fader),
        ).resolves.toMatchObject({ queued: true });
        expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
          "tok",
          queuedId(),
          expect.objectContaining({
            kind: "unknown",
            recovery: "retry-same-command",
          }),
          false,
        );
        expect(removeQueuedCommand).not.toHaveBeenCalled();
      },
    );

    it("keeps a rate-limited replay queued for the next drain", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("slow down", { status: 429 })),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader, {
          replaying: true,
          client_id: "replay-client",
          command_id: "replay-command",
          client_seq: 9,
        }),
      ).rejects.toThrow();
      expect(removeQueuedCommand).not.toHaveBeenCalled();
      expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
        "tok",
        "replay-command",
        expect.objectContaining({ kind: "unknown" }),
        false,
      );
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
          client_id: "replay-client",
          command_id: "replay-command",
          client_seq: 9,
        }),
      ).rejects.toThrow();
      expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
        "tok",
        "replay-command",
        expect.objectContaining({ kind: "refused", reason: "no edit" }),
        true,
      );
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
      expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
        "tok",
        queuedId(),
        expect.objectContaining({ kind: "unknown" }),
        false,
      );
    });

    it("rethrows a replay whose request never arrived, rather than returning queued", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("network down");
        }),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand("share:tok", "SetTrackFader", fader, {
          replaying: true,
          client_id: "replay-client",
          command_id: "replay-command",
          client_seq: 9,
        }),
      ).rejects.toThrow("network down");
      expect(removeQueuedCommand).not.toHaveBeenCalled();
      expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
        "tok",
        "replay-command",
        expect.objectContaining({ kind: "unknown" }),
        false,
      );
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
      return { persisted: true, hadPredecessor: false };
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
    expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
      "tok",
      queuedId,
      null,
      true,
    );
  });

  it("keeps a host replay queued after a server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 503 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand(
        "/tmp/episode.sharecut",
        "SetTrackMeta",
        {},
        {
          command_id: "replay-command",
          client_seq: 9,
          client_id: "replay-client",
          replaying: true,
        },
      ),
    ).resolves.toMatchObject({ queued: true, command_id: "replay-command" });
    expect(enqueueHostCommand).not.toHaveBeenCalled();
    expect(removeHostQueuedCommand).not.toHaveBeenCalled();
  });

  it.each([408, 429])(
    "keeps a host replay answered %i queued for the next drain",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("slow down", { status })),
      );
      const { submitDocumentCommand } = await import("./api");

      await expect(
        submitDocumentCommand(
          "/tmp/episode.sharecut",
          "SetTrackMeta",
          {},
          {
            command_id: "limited",
            client_id: "replay-client",
            client_seq: 3,
            replaying: true,
          },
        ),
      ).resolves.toMatchObject({ queued: true });
      expect(settleHostCommandOutcome).toHaveBeenCalledWith(
        "/tmp/episode.sharecut",
        "limited",
        expect.objectContaining({ kind: "unknown" }),
        false,
      );
      expect(removeHostQueuedCommand).not.toHaveBeenCalled();
    },
  );

  it("does not post a newer edit when storage failure hides an older one", async () => {
    const cause = new Error("quota exceeded");
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
    loadHostCommandQueue.mockResolvedValue([{ command_id: "older" }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
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
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
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

    expect(applyDocumentResult).toHaveBeenCalledWith(
      { ok: true, snapshot },
      expect.objectContaining({ path: "/tmp/project-a.json" }),
    );
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
      "/tmp/episode.sharecut",
      "SetTrackMeta",
      {
        label: "Host",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["enqueue", "fetch"]);
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      expect.any(String),
      null,
      true,
    );
  });

  it("returns queued for a server failure without losing the durable command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 503 })),
    );
    const { submitDocumentCommand } = await import("./api");

    const result = await submitDocumentCommand(
      "/tmp/episode.sharecut",
      "SetTrackMeta",
    );

    expect(result.queued).toBe(true);
    expect(removeHostQueuedCommand).not.toHaveBeenCalled();
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      expect.any(String),
      expect.objectContaining({ kind: "unknown" }),
      false,
    );
  });

  it("preserves the selected edits through durable approval and replay", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { approveEdits, submitDocumentCommand } = await import("./api");

    expect(await approveEdits("/tmp/episode.sharecut", ["a"], false)).toEqual({
      queued: true,
      count: null,
      historyHead: null,
      held: [],
    });
    const command = enqueueHostCommand.mock.calls[0][1] as {
      command_id: string;
      client_id: string;
      client_seq: number;
      payload: Record<string, unknown>;
    };
    expect(command.payload).toEqual({
      ids: ["a"],
    });

    await submitDocumentCommand(
      "/tmp/episode.sharecut",
      "ApproveEdits",
      command.payload,
      { ...command, replaying: true },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      payload: unknown;
    };
    expect(body.payload).toEqual({ ids: ["a"] });
  });

  it("reports an approval left queued behind older work", async () => {
    enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: true,
    });
    vi.stubGlobal("fetch", vi.fn());
    const { approveEdits } = await import("./api");
    await expect(approveEdits("/tmp/episode.sharecut", ["a"])).resolves.toEqual(
      {
        queued: true,
        count: null,
        historyHead: null,
        held: [],
      },
    );
  });

  it("reports a sent approval as not queued, with the history entry it recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              history_head_id: "a1b2c3d4e5f6",
              command: { payload: { result: { count: 1 } } },
            }),
            { status: 200 },
          ),
      ),
    );
    const { approveEdits } = await import("./api");
    await expect(approveEdits("/tmp/episode.sharecut", ["a"])).resolves.toEqual(
      {
        queued: false,
        count: 1,
        historyHead: "a1b2c3d4e5f6",
        held: [],
      },
    );
  });

  it("asks the host to hold blocked cuts and reports which it held", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            history_head_id: "a1b2c3d4e5f6",
            command: {
              payload: {
                result: {
                  count: 2,
                  held: [
                    { id: "e2", label: "Dani's cut at 1:02", reason: "x" },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { approveEdits } = await import("./api");
    const outcome = await approveEdits(
      "/tmp/episode.sharecut",
      ["a", "e2"],
      true,
    );
    const sent = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      payload: Record<string, unknown>;
    };
    expect(sent.payload).toMatchObject({ hold_blocked: true });
    expect(outcome.held).toEqual([
      { id: "e2", label: "Dani's cut at 1:02", reason: "x" },
    ]);
  });

  it.each([
    ["approve", 0, null],
    ["reject", 0, "a1b2c3d4e5f6"],
    ["approve", 2, "a1b2c3d4e5f6"],
    ["reject", 2, "a1b2c3d4e5f6"],
  ] as const)(
    "%s preserves actual count %i and its own head",
    async (action, count, head) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                history_head_id: head,
                command: { payload: { result: { count } } },
              }),
              { status: 200 },
            ),
        ),
      );
      const { approveEdits, rejectEdits } = await import("./api");
      const result = await (action === "approve" ? approveEdits : rejectEdits)(
        "/tmp/episode.sharecut",
        ["a"],
      );
      expect(result).toEqual({
        queued: false,
        count,
        historyHead: head,
        held: [],
      });
    },
  );

  it.each([undefined, -1, 0.5, "1", null])(
    "refuses malformed settled review count %s",
    async (count) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                history_head_id: "a1b2c3d4e5f6",
                command: { payload: { result: { count } } },
              }),
              { status: 200 },
            ),
        ),
      );
      const { rejectEdits } = await import("./api");
      await expect(rejectEdits("/tmp/episode.sharecut", ["a"])).rejects.toThrow(
        "The review reply is missing its affected edit count.",
      );
    },
  );

  it("keeps a guest command queued when its POST times out", async () => {
    enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Document command timed out", "TimeoutError");
      }),
    );
    const { submitDocumentCommand } = await import("./api");
    const { shareProjectKey } = await import("./shareMode");

    const result = await submitDocumentCommand(
      shareProjectKey("tok"),
      "AddComment",
      { body: "x" },
    );

    expect(result.queued).toBe(true);
    expect(removeQueuedCommand).not.toHaveBeenCalled();
  });

  it("keeps a timed-out host POST queued for the drain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException(
          "Host document command timed out",
          "TimeoutError",
        );
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    const result = await submitDocumentCommand(
      "/tmp/episode.sharecut",
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
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).resolves.toMatchObject({ queued: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects transport failure when storage could not persist", async () => {
    const cause = new Error("offline");
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
    const fetchSpy = vi.fn(async () => {
      throw cause;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).rejects.toThrow("offline");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      "/tmp/episode.sharecut",
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).resolves.toEqual({ ok: true });
  });

  it("records an unknown outcome when an unpersisted send loses its response", async () => {
    enqueueHostCommand.mockImplementationOnce(
      async (
        _path: string,
        _command: unknown,
        onPersistenceFailure: () => void,
      ) => {
        onPersistenceFailure();
        throw new Error("storage unavailable");
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).rejects.toThrow("network down");
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      expect.any(String),
      expect.objectContaining({ kind: "unknown", reason: expect.any(String) }),
      false,
    );
  });

  it("records a guest live refusal so its save state cannot return to Saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad payload", { status: 422 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("share:guest-refusal", "SetTrackMeta"),
    ).rejects.toThrow("bad payload");
    expect(settleGuestCommandOutcome).toHaveBeenCalledWith(
      "guest-refusal",
      expect.any(String),
      expect.objectContaining({ kind: "refused", reason: "bad payload" }),
      true,
    );
  });

  it("records conflicts and removes them from retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("stale revision", { status: 409 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).rejects.toThrow("stale revision");
    expect(settleHostCommandOutcome).toHaveBeenCalledOnce();
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
        "/tmp/episode.sharecut",
        "SetEnvelope",
        {},
        {
          command_id: "rejected-replay",
          client_id: "replay-client",
          client_seq: 1,
          replaying: true,
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      "rejected-replay",
      expect.objectContaining({
        kind: "refused",
        reason: "expected_points missing",
      }),
      true,
    );
  });

  it("records a live 4xx so save state cannot return to Saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad payload", { status: 422 })),
    );
    const { submitDocumentCommand } = await import("./api");

    await expect(
      submitDocumentCommand("/tmp/episode.sharecut", "SetTrackMeta"),
    ).rejects.toThrow("bad payload");
    expect(settleHostCommandOutcome).toHaveBeenCalledWith(
      "/tmp/episode.sharecut",
      expect.any(String),
      expect.objectContaining({ kind: "refused", reason: "bad payload" }),
      true,
    );
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
      "/tmp/episode.sharecut",
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
    // The module is mocked for the other tests; this one needs the real redisplay.
    const actual = await vi.importActual<
      typeof import("./document/applyDocumentUpdate")
    >("./document/applyDocumentUpdate");
    redisplayDrafts.mockImplementation(actual.redisplayDrafts);
    const { setEnvelope } = await import("./api");
    const next = [{ id: "a", time: 0, value: 0.5 }];

    await setEnvelope("/tmp/episode.sharecut", "host", next, [
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
      url.includes("phase=full")
        ? new Response(
            JSON.stringify({
              server_seq: 4,
              state_token: "a".repeat(64),
              patch: { envelopes },
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ detail: { detail: "changed" } }), {
            status: 409,
          }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { useDawStore } = await import("./state/dawStore");
    useDawStore.setState({ projectPath: "/tmp/episode.sharecut" });
    const { setEnvelope } = await import("./api");

    await expect(
      setEnvelope("/tmp/episode.sharecut", "host", [], []),
    ).rejects.toThrow("changed");
    expect(applyDocumentSnapshot).toHaveBeenCalledWith(
      { server_seq: 4, state_token: "a".repeat(64), patch: { envelopes } },
      { scope: expect.objectContaining({ path: "/tmp/episode.sharecut" }) },
    );
    useDawStore.setState({ projectPath: "" });
  });
});
