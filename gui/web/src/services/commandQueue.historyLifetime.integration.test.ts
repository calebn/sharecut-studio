import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({
  enqueueHostCommand: vi.fn(),
  enqueueCommand: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandQueue: vi.fn(),
  removeHostQueuedCommand: vi.fn(),
  removeQueuedCommand: vi.fn(),
}));
const drainRequests = vi.hoisted(() => ({
  host: vi.fn(),
  guest: vi.fn(),
}));

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("../state/offlineStore", () => queue);
vi.mock("../state/requestDrainLazy", () => ({
  requestHostDrainLazy: drainRequests.host,
  requestGuestDrainLazy: drainRequests.guest,
}));

describe("history command lifetime at queue admission", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    queue.loadHostCommandQueue.mockResolvedValue([]);
    queue.loadCommandQueue.mockResolvedValue([]);
    queue.enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    queue.enqueueCommand.mockResolvedValue(undefined);
    drainRequests.host.mockReset();
    drainRequests.guest.mockReset();
  });

  it.each([
    { action: "undo", route: "host", retirement: "reset" },
    { action: "redo", route: "host", retirement: "navigate" },
    { action: "undo", route: "guest", retirement: "navigate" },
    { action: "redo", route: "guest", retirement: "reset" },
  ] as const)(
    "does not post $route $action after a held enqueue and $retirement",
    async ({ action, route, retirement }) => {
      const path =
        route === "host" ? "/tmp/history-host.json" : "share:history-guest";
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
          history: {
            ...project.history,
            head_id: "visible-head",
            can_undo: true,
            can_redo: true,
          },
        },
      });
      authority.resetDocumentAuthority(path);
      clearRegisteredCommands();
      _resetHistoryMovesForTests();
      registerHistoryCommands();

      let releaseEnqueue!: (
        result: { persisted: true; hadPredecessor: false } | undefined,
      ) => void;
      const enqueueHeld = new Promise<
        { persisted: true; hadPredecessor: false } | undefined
      >((resolve) => {
        releaseEnqueue = resolve;
      });
      const enqueue =
        route === "host" ? queue.enqueueHostCommand : queue.enqueueCommand;
      enqueue.mockReturnValueOnce(enqueueHeld);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const move = execute(`history.${action}`);
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

      if (retirement === "reset") {
        authority.resetDocumentAuthority(path);
      } else {
        const nextPath =
          route === "host" ? "/tmp/other-project.json" : "share:other-guest";
        useDawStore.setState({ projectPath: nextPath });
        authority.resetDocumentAuthority(nextPath);
      }
      releaseEnqueue(
        route === "host"
          ? { persisted: true, hadPredecessor: false }
          : undefined,
      );

      await expect(move).resolves.toMatchObject({ status: "disabled" });

      const queued = enqueue.mock.calls[0]?.[1];
      const expectedType = action === "undo" ? "UndoHistory" : "RedoHistory";
      expect(queued).toMatchObject({
        type: expectedType,
        payload: { rerender: false, expected_head_id: "visible-head" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["UndoHistory", "RedoHistory"] as const)(
    "does not submit persisted %s during replay",
    async (type) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { replayQueuedCommands } = await import(
        "../state/drainOfflineQueue"
      );
      const settle = vi.fn(async () => {
        throw new Error("cleanup unavailable");
      });
      const source = {
        path: "/tmp/history-replay.json",
        load: async () => [
          {
            command_id: `history-${type}`,
            client_id: "client",
            client_seq: 1,
            type,
            payload: { rerender: false, expected_head_id: "head" },
            created_at: 1,
          },
        ],
        settle,
      };

      await expect(replayQueuedCommands(source)).rejects.toThrow(
        "cleanup unavailable",
      );
      await expect(replayQueuedCommands(source)).rejects.toThrow(
        "cleanup unavailable",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(settle).toHaveBeenNthCalledWith(1, [`history-${type}`]);
      expect(settle).toHaveBeenNthCalledWith(2, [`history-${type}`]);
    },
  );

  it("refuses direct replay submission for history command types", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitQueuedDocumentCommand } = await import("./commandQueue");
    await expect(
      submitQueuedDocumentCommand(
        "/tmp/history-replay.json",
        "UndoHistory",
        {},
        {
          command_id: "history-undo",
          client_id: "client",
          client_seq: 1,
          replaying: true,
        },
      ),
    ).rejects.toThrow("History commands must use submitLiveHistoryCommand");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["host", "guest"] as const)(
    "sends a current-scope %s history reservation with its expected head",
    async (route) => {
      const path =
        route === "host" ? "/tmp/history-live.json" : "share:history-live";
      const { useDawStore } = await import("../state/dawStore");
      const { minimalProject } = await import("../test/fixtures");
      const authority = await import("../document/authorityState");
      useDawStore.setState({ projectPath: path, project: minimalProject() });
      authority.resetDocumentAuthority(path);
      const command = {
        command_id: "history-live",
        client_id: "client",
        client_seq: 1,
        type: "UndoHistory",
        payload: { expected_head_id: "visible-head", rerender: false },
        created_at: 1,
      };
      if (route === "host") {
        queue.enqueueHostCommand.mockImplementationOnce(
          async (_path: string, enqueued: typeof command) => {
            queue.loadHostCommandQueue.mockResolvedValueOnce([enqueued]);
            return { persisted: true, hadPredecessor: false };
          },
        );
      } else {
        queue.enqueueCommand.mockImplementationOnce(
          async (_token: string, enqueued: typeof command) => {
            queue.loadCommandQueue.mockResolvedValueOnce([enqueued]);
          },
        );
      }
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ history_head_id: "landed-head" }),
      });
      vi.stubGlobal("fetch", fetchSpy);
      const { submitLiveHistoryCommand } = await import("./commandQueue");

      await expect(
        submitLiveHistoryCommand(
          path,
          "UndoHistory",
          command.payload,
          authority.documentScope(),
        ),
      ).resolves.toMatchObject({ history_head_id: "landed-head" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
      expect(body).toMatchObject({
        type: "UndoHistory",
        payload: { expected_head_id: "visible-head", rerender: false },
        role: route === "host" ? "viewer" : "guest",
      });
    },
  );

  it("refuses history behind older edits instead of reporting queued success", async () => {
    const path = "/tmp/history-older-edit.json";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    queue.enqueueHostCommand.mockResolvedValueOnce({
      persisted: true,
      hadPredecessor: true,
    });
    queue.loadHostCommandQueue.mockResolvedValueOnce([
      {
        command_id: "older-edit",
        client_id: "client",
        client_seq: 1,
        type: "SetTrackMeta",
        payload: {},
        created_at: 1,
      },
      {
        command_id: "history-live",
        client_id: "client",
        client_seq: 2,
        type: "UndoHistory",
        payload: { expected_head_id: "visible-head" },
        created_at: 2,
      },
    ]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { submitLiveHistoryCommand } = await import("./commandQueue");

    await expect(
      submitLiveHistoryCommand(
        path,
        "UndoHistory",
        { expected_head_id: "visible-head" },
        authority.documentScope(),
      ),
    ).rejects.toThrow("Undo and Redo must wait until older edits are sent");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queue.removeHostQueuedCommand).toHaveBeenCalledWith(
      path,
      expect.any(String),
    );
    expect(drainRequests.host).toHaveBeenCalledWith(path);
  });

  it("refuses offline history before writing an ordering reservation", async () => {
    const path = "/tmp/history-offline.json";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const { submitLiveHistoryCommand } = await import("./commandQueue");

    await expect(
      submitLiveHistoryCommand(
        path,
        "RedoHistory",
        { expected_head_id: "visible-head" },
        authority.documentScope(),
      ),
    ).rejects.toThrow("Undo and Redo are unavailable offline");

    expect(queue.enqueueHostCommand).not.toHaveBeenCalled();
  });
});
