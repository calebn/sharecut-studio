import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueuedCommand } from "../state/offlineStore";
import { commandLocks } from "../test/commandLocks";

const storage = vi.hoisted(() => ({
  rows: [] as QueuedCommand[],
}));
vi.mock("../state/offlineStore", () => ({
  enqueueCommand: async (_: string, command: (typeof storage.rows)[number]) => {
    const hadPredecessor = storage.rows.length > 0;
    storage.rows.push(command);
    return { persisted: true, hadPredecessor };
  },
  enqueueHostCommand: async (
    _: string,
    command: (typeof storage.rows)[number],
  ) => {
    const hadPredecessor = storage.rows.length > 0;
    storage.rows.push(command);
    return { persisted: true, hadPredecessor };
  },
  loadCommandQueue: async () => [...storage.rows],
  loadHostCommandQueue: async () => [...storage.rows],
  removeQueuedCommand: async (_: string, id: string) => {
    storage.rows = storage.rows.filter((c) => c.command_id !== id);
  },
  removeHostQueuedCommand: async (_: string, id: string) => {
    storage.rows = storage.rows.filter((c) => c.command_id !== id);
  },
  removeHostQueuedCommands: async (_: string, ids: string[]) => {
    storage.rows = storage.rows.filter((c) => !ids.includes(c.command_id));
  },
  removeQueuedCommands: async (_: string, ids: string[]) => {
    storage.rows = storage.rows.filter((c) => !ids.includes(c.command_id));
  },
  settleHostCommandOutcome: async (
    _: string,
    id: string,
    _outcome: unknown,
    remove: boolean,
  ) => {
    if (remove) storage.rows = storage.rows.filter((c) => c.command_id !== id);
  },
  settleGuestCommandOutcome: async (
    _: string,
    id: string,
    _outcome: unknown,
    remove: boolean,
  ) => {
    if (remove) storage.rows = storage.rows.filter((c) => c.command_id !== id);
  },
}));
vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("./offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
  requestGuestDrainLazy: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  storage.rows = [];
  sessionStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["host", "guest"])(
  "keeps later %s live edits, replay and history behind active history",
  async (route) => {
    const path =
      route === "host" ? "/tmp/active-history.json" : "share:active-history";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted: string[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      posted.push(body.type);
      if (posted.length === 1) await held;
      return {
        ok: true,
        status: 200,
        json: async () => ({ history_head_id: "landed" }),
      };
    });
    vi.stubGlobal("fetch", fetcher);
    const api = await import("./commandQueue");
    const first = api.submitLiveHistoryCommand(
      path,
      "UndoHistory",
      { expected_head_id: "head" },
      authority.documentScope(),
    );
    await vi.waitFor(() => expect(posted).toEqual(["UndoHistory"]));
    const edit = api.submitQueuedDocumentCommand(path, "SetTrackMeta", {
      name: "later",
    });
    const replay = api.submitQueuedDocumentCommand(
      path,
      "SetTrackMeta",
      { name: "replayed" },
      {
        command_id: "replay",
        client_id: "client",
        client_seq: 3,
        replaying: true,
      },
    );
    const second = api
      .submitLiveHistoryCommand(
        path,
        "RedoHistory",
        { expected_head_id: "landed" },
        authority.documentScope(),
      )
      .then(
        () => "applied",
        (error) => String(error),
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = [...posted];
    release();
    const results = await Promise.all([first, edit, replay, second]);
    expect(during).toEqual(["UndoHistory"]);
    expect(results[3]).toBe("applied");
    expect(posted).toEqual([
      "UndoHistory",
      "SetTrackMeta",
      "SetTrackMeta",
      "RedoHistory",
    ]);
  },
);

it.each(["host", "guest"])(
  "keeps a %s drain behind active history and replays ordinary edits in order",
  async (route) => {
    const path =
      route === "host" ? "/tmp/drain-history.json" : "share:drain-history";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        posted.push(body.type);
        if (posted.length === 1) await held;
        return {
          ok: true,
          status: 200,
          json: async () => ({ history_head_id: "landed" }),
        };
      }),
    );
    const { submitLiveHistoryCommand } = await import("./commandQueue");
    const first = submitLiveHistoryCommand(
      path,
      "UndoHistory",
      { expected_head_id: "head" },
      authority.documentScope(),
    );
    await vi.waitFor(() => expect(posted).toEqual(["UndoHistory"]));
    const { replayQueuedCommands } = await import(
      "./offlineQueue/drainOfflineQueue"
    );
    const history = storage.rows[0];
    const source = {
      path,
      load: async () => [
        history,
        {
          ...history,
          command_id: "A",
          client_seq: 2,
          type: "SetTrackMeta",
          created_at: 2,
        },
        {
          ...history,
          command_id: "B",
          client_seq: 3,
          type: "SetTrackGain",
          created_at: 3,
        },
      ],
    };
    const drain = replayQueuedCommands(source);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = [...posted];
    release();
    await Promise.all([first, drain]);
    expect(during).toEqual(["UndoHistory"]);
    expect(posted).toEqual(["UndoHistory", "SetTrackMeta", "SetTrackGain"]);
  },
);

it.each(["host", "guest"])(
  "refuses a retired %s scope after waiting for browser ownership",
  async (route) => {
    const path =
      route === "host" ? "/tmp/wait-history.json" : "share:wait-history";
    const { useDawStore } = await import("../state/dawStore");
    const { minimalProject } = await import("../test/fixtures");
    const authority = await import("../document/authorityState");
    useDawStore.setState({ projectPath: path, project: minimalProject() });
    authority.resetDocumentAuthority(path);
    const scope = authority.documentScope();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = navigator.locks.request(
      `sharecut:command-send:${path}`,
      { mode: "shared" },
      async () => {
        entered();
        await held;
      },
    );
    await acquired;
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({ history_head_id: "landed" }),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = await import("./commandQueue");
    const history = api
      .submitLiveHistoryCommand(
        path,
        "UndoHistory",
        { expected_head_id: "head" },
        scope,
      )
      .then(
        () => "applied",
        (error) => error.code,
      );
    const edit = api
      .submitQueuedDocumentCommand(path, "SetTrackMeta", {
        name: "kept",
      })
      .then(
        (result) => result,
        (error) => error,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
    authority.resetDocumentAuthority(path);
    release();
    const result = await history;
    await Promise.all([owner, edit]);
    expect(result).toBe("history_stale");
    expect(
      fetcher.mock.calls.map(
        (call) => JSON.parse(call[1]?.body as string).type,
      ),
    ).toEqual(["SetTrackMeta"]);
  },
);

it("keeps ordinary recovery usable when browser ownership is unavailable", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  const path = "/tmp/unsupported-history.json";
  const { useDawStore } = await import("../state/dawStore");
  const { minimalProject } = await import("../test/fixtures");
  const authority = await import("../document/authorityState");
  useDawStore.setState({ projectPath: path, project: minimalProject() });
  authority.resetDocumentAuthority(path);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("disconnected")));
  const api = await import("./commandQueue");
  await expect(
    api.submitLiveHistoryCommand(
      path,
      "UndoHistory",
      { expected_head_id: "head" },
      authority.documentScope(),
    ),
  ).rejects.toThrow("unavailable in this browser");
  const result = await api.submitQueuedDocumentCommand(path, "SetTrackMeta", {
    name: "kept",
  });
  expect(result.queued).toBe(true);
  expect(storage.rows.map((command) => command.type)).toEqual(["SetTrackMeta"]);
});
