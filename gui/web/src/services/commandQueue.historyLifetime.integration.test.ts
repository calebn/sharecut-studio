import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";
import type { HistoryEntryId } from "../types/project";
import type { QueuedCommand } from "./offlineQueue/offlineStore";

const queue = vi.hoisted(() => ({
  enqueueHostCommand: vi.fn(),
  enqueueCommand: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandQueue: vi.fn(),
  removeHostQueuedCommand: vi.fn(),
  removeQueuedCommand: vi.fn(),
  settleHostCommandOutcome: vi.fn(),
  settleGuestCommandOutcome: vi.fn(),
}));
const drainRequests = vi.hoisted(() => ({
  host: vi.fn(),
  guest: vi.fn(),
}));

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("./offlineQueue/offlineStore", () => queue);
vi.mock("./offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: drainRequests.host,
  requestGuestDrainLazy: drainRequests.guest,
}));

describe("history command lifetime at queue admission", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    queue.loadHostCommandQueue.mockResolvedValue([]);
    queue.loadCommandQueue.mockResolvedValue([]);
    queue.enqueueHostCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    queue.enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    queue.settleHostCommandOutcome.mockResolvedValue(undefined);
    queue.settleGuestCommandOutcome.mockResolvedValue(undefined);
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
            head_id: "visible-head" as HistoryEntryId,
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

  it.each(["host", "guest"] as const)(
    "keeps a live %s Undo reservation when its unknown outcome cannot be saved",
    async (route) => {
      const path =
        route === "host"
          ? "/tmp/history-unknown-host.json"
          : "share:history-unknown-guest";
      const token = "history-unknown-guest";
      const rows: QueuedCommand[] = [];
      const enqueue = async (_key: string, command: QueuedCommand) => {
        rows.push(command);
        return { persisted: true, hadPredecessor: false };
      };
      const load = async () => [...rows];
      const remove = async (_key: string, commandId: string) => {
        for (let index = rows.length - 1; index >= 0; index--) {
          if (rows[index]?.command_id === commandId) rows.splice(index, 1);
        }
      };
      if (route === "host") {
        queue.enqueueHostCommand.mockImplementation(enqueue);
        queue.loadHostCommandQueue.mockImplementation(load);
        queue.removeHostQueuedCommand.mockImplementation(remove);
        queue.settleHostCommandOutcome.mockRejectedValue(
          new Error("IndexedDB unavailable"),
        );
      } else {
        queue.enqueueCommand.mockImplementation(enqueue);
        queue.loadCommandQueue.mockImplementation(load);
        queue.removeQueuedCommand.mockImplementation(remove);
        queue.settleGuestCommandOutcome.mockRejectedValue(
          new Error("IndexedDB unavailable"),
        );
      }

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
          history: { ...project.history, can_undo: true, can_redo: false },
        },
      });
      authority.resetDocumentAuthority(path);
      clearRegisteredCommands();
      _resetHistoryMovesForTests();
      registerHistoryCommands();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("network down");
        }),
      );

      await expect(execute("history.undo")).rejects.toThrow();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "UndoHistory" });
      expect(
        route === "host"
          ? queue.removeHostQueuedCommand
          : queue.removeQueuedCommand,
      ).not.toHaveBeenCalledWith(
        route === "host" ? path : token,
        rows[0]?.command_id,
      );
    },
  );

  it.each(["UndoHistory", "RedoHistory"] as const)(
    "does not submit persisted %s during replay",
    async (type) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { replayQueuedCommands } = await import(
        "./offlineQueue/drainOfflineQueue"
      );
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
      };

      await replayQueuedCommands(source);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(queue.settleHostCommandOutcome).toHaveBeenCalledWith(
        "/tmp/history-replay.json",
        `history-${type}`,
        expect.objectContaining({
          command: expect.objectContaining({ command_id: `history-${type}` }),
          kind: "unknown",
          recovery: "inspect-history",
        }),
        true,
      );
    },
  );

  it.each(["host", "guest"] as const)(
    "uses the landed head of a %s edit invoked behind H1 before H2 is pressed",
    async (route) => {
      const path =
        route === "host"
          ? "/tmp/history-save-order.json"
          : "share:history-save-order";
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
            head_id: "visible-head" as HistoryEntryId,
            can_undo: true,
            can_redo: true,
          },
        },
      });
      authority.resetDocumentAuthority(path);
      clearRegisteredCommands();
      _resetHistoryMovesForTests();
      registerHistoryCommands();

      const rows: { command_id: string; type: string; payload: object }[] = [];
      const enqueue = (command: (typeof rows)[number]) => {
        rows.push(command);
        return { persisted: true, hadPredecessor: rows.length > 1 };
      };
      const remove = (_key: string, commandId: string) => {
        const index = rows.findIndex((row) => row.command_id === commandId);
        if (index >= 0) rows.splice(index, 1);
      };
      queue.enqueueHostCommand.mockImplementation(async (_path, command) =>
        enqueue(command as (typeof rows)[number]),
      );
      queue.enqueueCommand.mockImplementation(async (_token, command) =>
        enqueue(command as (typeof rows)[number]),
      );
      queue.loadHostCommandQueue.mockImplementation(
        async () => [...rows] as never,
      );
      queue.loadCommandQueue.mockImplementation(async () => [...rows] as never);
      queue.removeHostQueuedCommand.mockImplementation(async (key, commandId) =>
        remove(key, commandId),
      );
      queue.removeQueuedCommand.mockImplementation(async (key, commandId) =>
        remove(key, commandId),
      );
      queue.settleHostCommandOutcome.mockImplementation(
        async (key, commandId, _outcome, removeFromQueue) => {
          if (removeFromQueue) remove(key, commandId);
        },
      );
      queue.settleGuestCommandOutcome.mockImplementation(
        async (key, commandId, _outcome, removeFromQueue) => {
          if (removeFromQueue) remove(key, commandId);
        },
      );

      let releaseH1!: (response: Response) => void;
      const h1Response = new Promise<Response>((resolve) => {
        releaseH1 = resolve;
      });
      let h1Entered!: () => void;
      const h1Started = new Promise<void>((resolve) => {
        h1Entered = resolve;
      });
      let eWaiting!: () => void;
      const eWaitStarted = new Promise<void>((resolve) => {
        eWaiting = resolve;
      });
      const nativeLocks = commandLocks();
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: (
            name: string,
            options: LockOptions,
            callback: (lock: Lock | null) => unknown,
          ) => {
            if (options.mode === "shared") eWaiting();
            return nativeLocks.request(name, options, callback);
          },
        },
      });
      let serverHead = "visible-head";
      const commandBody = (init?: RequestInit) =>
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          type: string;
          payload: { expected_head_id?: string };
        };
      const fetchSpy = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = commandBody(init);
          if (
            body.type === "UndoHistory" &&
            body.payload.expected_head_id === "visible-head"
          ) {
            h1Entered();
            return h1Response;
          }
          if (
            (body.type === "UndoHistory" || body.type === "RedoHistory") &&
            body.payload.expected_head_id !== serverHead
          ) {
            return new Response(JSON.stringify({ detail: "history_stale" }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
          }
          serverHead = body.type === "AddChapter" ? "edit-head" : "undo-head";
          return new Response(
            JSON.stringify({
              history_head_id: serverHead,
              server_seq: fetchSpy.mock.calls.length,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );
      vi.stubGlobal("fetch", fetchSpy);

      const firstUndo = execute("history.undo");
      await h1Started;
      const { submitQueuedDocumentCommand } = await import("./commandQueue");
      const edit = submitQueuedDocumentCommand(path, "AddChapter", {
        title: "Chapter",
        start_sec: 1,
      });
      await eWaitStarted;
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const secondUndo = execute("history.undo");

      serverHead = "h1-head";
      releaseH1(
        new Response(
          JSON.stringify({ history_head_id: "h1-head", server_seq: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await expect(firstUndo).resolves.toMatchObject({ status: "ok" });
      await expect(edit).resolves.toMatchObject({
        history_head_id: "edit-head",
      });
      await expect(secondUndo).resolves.toMatchObject({ status: "ok" });

      const historyBodies = fetchSpy.mock.calls
        .map(([, init]) => commandBody(init))
        .filter((body) => body.type === "UndoHistory");
      expect(
        historyBodies.map((body) => body.payload.expected_head_id),
      ).toEqual(["visible-head", "edit-head"]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
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
        payload: {
          expected_head_id: "visible-head" as HistoryEntryId,
          rerender: false,
        },
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
        payload: {
          expected_head_id: "visible-head" as HistoryEntryId,
          rerender: false,
        },
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

  it("keeps a prior-client guest edit ahead of a new history reservation", async () => {
    const path = "share:history-prior-client-edit";
    const token = "history-prior-client-edit";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    queue.enqueueCommand.mockImplementationOnce(async (_token, history) => {
      queue.loadCommandQueue.mockResolvedValueOnce([
        {
          command_id: "prior-tab-edit",
          client_id: "prior-tab",
          client_seq: 9,
          type: "SetTrackMeta",
          payload: {},
          created_at: 1,
        },
        history,
      ]);
    });
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
    expect(queue.removeQueuedCommand).toHaveBeenCalledWith(
      token,
      expect.any(String),
    );
    expect(drainRequests.guest).toHaveBeenCalledWith(token);
  });

  it("refuses guest history when its reservation was not stored", async () => {
    const path = "share:history-unavailable-storage";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    queue.loadCommandQueue.mockResolvedValueOnce([]);
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
    ).rejects.toThrow(
      "Undo and Redo cannot run right now. Reload the project and try again.",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(drainRequests.guest).not.toHaveBeenCalled();
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
