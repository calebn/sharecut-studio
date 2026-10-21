import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineConflict, QueuedCommand } from "./offlineStore";

const hostQueues = new Map<string, QueuedCommand[]>();
const guestQueues = new Map<string, QueuedCommand[]>();
const hostConflicts: OfflineConflict[] = [];
const guestConflicts: OfflineConflict[] = [];
let conflictReadFailure = false;

const without = (queue: QueuedCommand[] | undefined, ids: string[]) =>
  (queue ?? []).filter((c) => !ids.includes(c.command_id));

vi.mock("../../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  applyDocumentSnapshot: vi.fn(),
  mergeGuestActionDone: vi.fn(),
  mergeReturnedComment: vi.fn(),
}));

vi.mock("./offlineStore", () => ({
  loadHostCommandQueue: async (path: string) => [
    ...(hostQueues.get(path) ?? []),
  ],
  enqueueHostCommand: async () => {
    throw new Error("a replay never enqueues a host record");
  },
  removeHostQueuedCommand: async (path: string, id: string) => {
    hostQueues.set(path, without(hostQueues.get(path), [id]));
  },
  removeHostQueuedCommands: async (path: string, ids: string[]) => {
    hostQueues.set(path, without(hostQueues.get(path), ids));
  },
  addHostConflict: async (_path: string, conflict: OfflineConflict) => {
    if (conflictReadFailure) throw new Error("Invalid saved conflict");
    hostConflicts.push(conflict);
  },
  settleHostCommandOutcome: async (
    path: string,
    id: string,
    outcome: OfflineConflict | null,
    remove: boolean,
  ) => {
    if (conflictReadFailure && outcome)
      throw new Error("Invalid saved conflict");
    if (outcome) hostConflicts.push(outcome);
    if (remove) hostQueues.set(path, without(hostQueues.get(path), [id]));
  },
  loadCommandQueue: async (token: string) => [
    ...(guestQueues.get(token) ?? []),
  ],
  // Like the real store: re-enqueueing an id replaces the row where it stands.
  enqueueCommand: async (token: string, cmd: QueuedCommand) => {
    const queue = guestQueues.get(token) ?? [];
    const hadPredecessor = queue.length > 0;
    guestQueues.set(
      token,
      queue.some((c) => c.command_id === cmd.command_id)
        ? queue.map((c) => (c.command_id === cmd.command_id ? cmd : c))
        : [...queue, cmd],
    );
    return { persisted: true, hadPredecessor };
  },
  removeQueuedCommand: async (token: string, id: string) => {
    guestQueues.set(token, without(guestQueues.get(token), [id]));
  },
  removeQueuedCommands: async (token: string, ids: string[]) => {
    guestQueues.set(token, without(guestQueues.get(token), ids));
  },
  addConflict: async (_token: string, conflict: OfflineConflict) => {
    if (conflictReadFailure) throw new Error("Invalid saved conflict");
    guestConflicts.push(conflict);
  },
  settleGuestCommandOutcome: async (
    token: string,
    id: string,
    outcome: OfflineConflict | null,
    remove: boolean,
  ) => {
    if (conflictReadFailure && outcome)
      throw new Error("Invalid saved conflict");
    if (outcome) guestConflicts.push(outcome);
    if (remove) guestQueues.set(token, without(guestQueues.get(token), [id]));
  },
}));

const PATH = "/projects/integration.project.json";
const TOKEN = "integration";

const rec = (id: string, seq: number): QueuedCommand => ({
  command_id: id,
  client_id: "tab-1",
  client_seq: seq,
  type: "SetTrackMeta",
  payload: { label: id },
  structural_mode: "apply",
  created_at: seq,
});

/** Answer each POST by its command_id: an HTTP status (default 200) or "offline". */
function stubServer(answers: Record<string, number | "offline">): string[] {
  const posted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const { command_id } = JSON.parse(init.body as string) as {
        command_id: string;
      };
      posted.push(command_id);
      const answer = answers[command_id] ?? 200;
      if (answer === "offline") throw new TypeError("network down");
      if (answer === 200) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("refused", { status: answer });
    }),
  );
  return posted;
}

/** Queued ids in replay (stored) order. */
const ids = (queue: QueuedCommand[] | undefined) =>
  (queue ?? []).map((c) => c.command_id);

beforeEach(() => {
  conflictReadFailure = false;
  hostQueues.clear();
  guestQueues.clear();
  hostConflicts.length = 0;
  guestConflicts.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("host drain against the real submit layer", () => {
  const drain = async () =>
    (await import("./drainOfflineQueue")).drainHostOfflineQueue(PATH);

  it("skips a refused replay only after the submit layer recorded and dequeued it", async () => {
    hostQueues.set(PATH, [rec("a", 1), rec("bad", 2), rec("c", 3)]);
    const posted = stubServer({ bad: 403 });

    await drain();

    expect(posted).toEqual(["a", "bad", "c"]);
    expect(hostConflicts).toMatchObject([
      {
        command: { ...rec("bad", 2), created_at: expect.any(Number) },
        kind: "refused",
        reason: "refused",
        recovery: "edit-and-resubmit",
      },
    ]);
    expect(ids(hostQueues.get(PATH))).toEqual([]);
  });

  it("does not resend a refusal while its durable settlement is retried", async () => {
    hostQueues.set(PATH, [rec("bad", 1), rec("next", 2)]);
    const posted = stubServer({ bad: 403 });
    conflictReadFailure = true;
    await drain();
    expect(posted).toEqual(["bad"]);
    expect(ids(hostQueues.get(PATH))).toEqual(["bad", "next"]);
    expect(hostConflicts).toEqual([]);
    await drain();
    expect(posted).toEqual(["bad"]);
    expect(ids(hostQueues.get(PATH))).toEqual(["bad", "next"]);
    conflictReadFailure = false;
    await drain();
    expect(posted).toEqual(["bad", "next"]);
    expect(hostConflicts[0]).toMatchObject({
      kind: "refused",
      command: {
        client_id: "tab-1",
        command_id: "bad",
        client_seq: 1,
        structural_mode: "apply",
      },
    });
    expect(ids(hostQueues.get(PATH))).toEqual([]);
  });

  it.each([408, 429, 503, "offline" as const])(
    "stops at a replay answered %s and keeps it queued in order",
    async (answer) => {
      hostQueues.set(PATH, [rec("a", 1), rec("held", 2), rec("c", 3)]);
      const posted = stubServer({ held: answer });

      await drain();

      expect(posted).toEqual(["a", "held"]);
      expect(hostConflicts).toMatchObject([
        { kind: "unknown", command: { command_id: "held" } },
      ]);
      expect(ids(hostQueues.get(PATH))).toEqual(["held", "c"]);
    },
  );

  it("records orphaned history as inspect-only uncertainty before later work", async () => {
    hostQueues.set(PATH, [
      { ...rec("undo", 1), type: "UndoHistory" },
      rec("next", 2),
    ]);
    const posted = stubServer({});
    conflictReadFailure = true;

    await drain();

    expect(posted).toEqual([]);
    expect(ids(hostQueues.get(PATH))).toEqual(["undo", "next"]);
    expect(hostConflicts).toEqual([]);

    conflictReadFailure = false;
    await drain();

    expect(posted).toEqual(["next"]);
    expect(hostConflicts).toMatchObject([
      {
        command: { command_id: "undo", type: "UndoHistory" },
        kind: "unknown",
        recovery: "inspect-history",
      },
    ]);
    expect(ids(hostQueues.get(PATH))).toEqual([]);
  });
});

describe("guest drain against the real submit layer", () => {
  const drain = async () =>
    (await import("./drainOfflineQueue")).drainOfflineQueue(TOKEN);
  const live = async (id: string) => {
    const { submitDocumentCommand } = await import("../../api");
    return submitDocumentCommand(
      `share:${TOKEN}`,
      "SetTrackMeta",
      { label: id },
      { command_id: id },
    );
  };

  it("skips a refused replay only after the submit layer recorded and dequeued it", async () => {
    guestQueues.set(TOKEN, [rec("a", 1), rec("bad", 2), rec("c", 3)]);
    const posted = stubServer({ bad: 403 });

    await drain();

    expect(posted).toEqual(["a", "bad", "c"]);
    expect(guestConflicts).toMatchObject([
      {
        command: { ...rec("bad", 2), created_at: expect.any(Number) },
        kind: "refused",
        reason: "refused",
        recovery: "edit-and-resubmit",
      },
    ]);
    expect(ids(guestQueues.get(TOKEN))).toEqual([]);
  });

  it("does not resend a refusal while its durable settlement is retried", async () => {
    guestQueues.set(TOKEN, [rec("bad", 1), rec("next", 2)]);
    const posted = stubServer({ bad: 403 });
    conflictReadFailure = true;
    await drain();
    expect(posted).toEqual(["bad"]);
    expect(ids(guestQueues.get(TOKEN))).toEqual(["bad", "next"]);
    expect(guestConflicts).toEqual([]);
    await drain();
    expect(posted).toEqual(["bad"]);
    expect(ids(guestQueues.get(TOKEN))).toEqual(["bad", "next"]);
    conflictReadFailure = false;
    await drain();
    expect(posted).toEqual(["bad", "next"]);
    expect(guestConflicts[0]).toMatchObject({
      kind: "refused",
      command: {
        client_id: "tab-1",
        command_id: "bad",
        client_seq: 1,
        structural_mode: "apply",
      },
    });
    expect(ids(guestQueues.get(TOKEN))).toEqual([]);
  });

  it.each([408, 429, 503, "offline" as const])(
    "stops at a replay answered %s and keeps it queued in order",
    async (answer) => {
      guestQueues.set(TOKEN, [rec("a", 1), rec("held", 2), rec("c", 3)]);
      const posted = stubServer({ held: answer });

      await drain();

      expect(posted).toEqual(["a", "held"]);
      expect(guestConflicts).toMatchObject([
        { kind: "unknown", command: { command_id: "held" } },
      ]);
      expect(ids(guestQueues.get(TOKEN))).toEqual(["held", "c"]);
    },
  );

  it("records orphaned history as inspect-only uncertainty before later work", async () => {
    guestQueues.set(TOKEN, [
      { ...rec("undo", 1), type: "UndoHistory" },
      rec("next", 2),
    ]);
    const posted = stubServer({});
    conflictReadFailure = true;

    await drain();

    expect(posted).toEqual([]);
    expect(ids(guestQueues.get(TOKEN))).toEqual(["undo", "next"]);
    expect(guestConflicts).toEqual([]);

    conflictReadFailure = false;
    await drain();

    expect(posted).toEqual(["next"]);
    expect(guestConflicts).toMatchObject([
      {
        command: { command_id: "undo", type: "UndoHistory" },
        kind: "unknown",
        recovery: "inspect-history",
      },
    ]);
    expect(ids(guestQueues.get(TOKEN))).toEqual([]);
  });

  describe("a live edit made while older rows are queued", () => {
    it("stays queued behind a held replay, is not POSTed, and replays after it", async () => {
      guestQueues.set(TOKEN, [rec("old", 9)]);
      const answers: Record<string, number | "offline"> = { old: 503 };
      const posted = stubServer(answers);
      await drain();
      expect(posted).toEqual(["old"]);

      const result = await live("live");

      expect(result).toMatchObject({ queued: true, command_id: "live" });
      await vi.waitFor(() => expect(posted.length).toBeGreaterThan(1));
      expect(posted).not.toContain("live");
      expect(ids(guestQueues.get(TOKEN))).toEqual(["old", "live"]);

      delete answers.old;
      posted.length = 0;
      await drain();
      expect(posted).toEqual(["old", "live"]);
      expect(ids(guestQueues.get(TOKEN))).toEqual([]);
    });
  });

  describe("a live guest send still in flight", () => {
    function gatedServer(held: string) {
      const posted: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const { command_id } = JSON.parse(init.body as string) as {
            command_id: string;
          };
          posted.push(command_id);
          if (command_id === held) await gate;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      );
      return { posted, release };
    }

    it("is not replayed by a drain that runs while it is in flight", async () => {
      const { posted, release } = gatedServer("one");
      const first = live("one");
      await vi.waitFor(() => expect(posted).toEqual(["one"]));

      const replay = drain();
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.all([first, replay]);

      expect(posted).toEqual(["one"]);
      expect(ids(guestQueues.get(TOKEN))).toEqual([]);
    });

    it("posts a second live edit only after the first one's reply", async () => {
      const { posted, release } = gatedServer("one");
      const first = live("one");
      await vi.waitFor(() => expect(posted).toEqual(["one"]));
      const second = live("two");
      await new Promise((r) => setTimeout(r, 50));
      const beforeRelease = [...posted];
      release();
      await first;

      await second;
      expect(beforeRelease).toEqual(["one"]);
      expect(posted).toEqual(["one", "two"]);
    });

    it("records one Needs attention entry when a refused live edit overlaps a reconnect drain", async () => {
      const posted: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const { command_id } = JSON.parse(init.body as string) as {
            command_id: string;
          };
          posted.push(command_id);
          await gate;
          return new Response("refused", { status: 409 });
        }),
      );
      const first = live("bad").catch((e: unknown) => e);
      await vi.waitFor(() => expect(posted).toEqual(["bad"]));
      const replay = drain();
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.all([first, replay]);

      expect(guestConflicts.map((c) => c.command.command_id)).toEqual(["bad"]);
    });
  });
});
