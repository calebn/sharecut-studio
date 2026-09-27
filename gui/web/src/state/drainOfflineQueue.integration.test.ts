import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineConflict, QueuedCommand } from "./offlineStore";

// Runs both drains through the real submit layer (services/commandQueue.ts)
// over an in-memory queue and a stubbed fetch. The driver skips a permanent
// rejection only because the submit layer already dequeued it; this pins that.

const hostQueues = new Map<string, QueuedCommand[]>();
const guestQueues = new Map<string, QueuedCommand[]>();
const hostConflicts: string[] = [];
const guestConflicts: string[] = [];

const without = (queue: QueuedCommand[] | undefined, ids: string[]) =>
  (queue ?? []).filter((c) => !ids.includes(c.command_id));

vi.mock("../document/applyDocumentUpdate", () => ({
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
    hostConflicts.push(conflict.command.command_id);
  },
  loadCommandQueue: async (token: string) => [
    ...(guestQueues.get(token) ?? []),
  ],
  // Like the real store: re-enqueueing an id moves it to the end.
  enqueueCommand: async (token: string, cmd: QueuedCommand) => {
    guestQueues.set(token, [
      ...without(guestQueues.get(token), [cmd.command_id]),
      cmd,
    ]);
  },
  removeQueuedCommand: async (token: string, id: string) => {
    guestQueues.set(token, without(guestQueues.get(token), [id]));
  },
  addConflict: async (_token: string, conflict: OfflineConflict) => {
    guestConflicts.push(conflict.command.command_id);
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

/** Queued ids in replay (client_seq) order. */
const ids = (queue: QueuedCommand[] | undefined) =>
  [...(queue ?? [])]
    .sort((a, b) => a.client_seq - b.client_seq)
    .map((c) => c.command_id);

beforeEach(() => {
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
    expect(hostConflicts).toEqual(["bad"]);
    expect(ids(hostQueues.get(PATH))).toEqual([]);
  });

  it.each([408, 429, 503, "offline" as const])(
    "stops at a replay answered %s and keeps it queued in order",
    async (answer) => {
      hostQueues.set(PATH, [rec("a", 1), rec("held", 2), rec("c", 3)]);
      const posted = stubServer({ held: answer });

      await drain();

      expect(posted).toEqual(["a", "held"]);
      expect(hostConflicts).toEqual([]);
      expect(ids(hostQueues.get(PATH))).toEqual(["held", "c"]);
    },
  );
});

describe("guest drain against the real submit layer", () => {
  const drain = async () =>
    (await import("./drainOfflineQueue")).drainOfflineQueue(TOKEN);

  it("skips a refused replay only after the submit layer recorded and dequeued it", async () => {
    guestQueues.set(TOKEN, [rec("a", 1), rec("bad", 2), rec("c", 3)]);
    const posted = stubServer({ bad: 403 });

    await drain();

    expect(posted).toEqual(["a", "bad", "c"]);
    expect(guestConflicts).toEqual(["bad"]);
    expect(ids(guestQueues.get(TOKEN))).toEqual([]);
  });

  it.each([408, 429, 503, "offline" as const])(
    "stops at a replay answered %s and keeps it queued in order",
    async (answer) => {
      guestQueues.set(TOKEN, [rec("a", 1), rec("held", 2), rec("c", 3)]);
      const posted = stubServer({ held: answer });

      await drain();

      expect(posted).toEqual(["a", "held"]);
      expect(guestConflicts).toEqual([]);
      expect(ids(guestQueues.get(TOKEN))).toEqual(["held", "c"]);
    },
  );
});
