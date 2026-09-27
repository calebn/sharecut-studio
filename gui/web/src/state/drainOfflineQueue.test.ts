import { beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { ApiError } from "../utils/apiError";
import type { QueuedCommand } from "./offlineStore";
import { chainQueuedEnvelopeBaseline } from "./queuedEnvelopeBaseline";

const submit = vi.fn();
const hostQueue = vi.fn();
const guestQueue = vi.fn();
const removeHostQueuedCommands = vi.fn();

vi.mock("../api", () => ({ submitDocumentCommand: submit }));
vi.mock("./offlineStore", () => ({
  loadCommandQueue: guestQueue,
  loadHostCommandQueue: hostQueue,
  removeHostQueuedCommands,
}));

const cmd = (id: string): QueuedCommand => ({
  command_id: id,
  client_seq: 1,
  type: "SetTrackMeta",
  payload: {},
  created_at: 0,
});

describe("drainHostOfflineQueue", () => {
  it("requestHostDrain publishes its run until it settles", async () => {
    const path = "/projects/published.project.json";
    hostQueue.mockResolvedValue([]);
    const { requestHostDrain } = await import("./drainOfflineQueue");
    const { activeHostDrain } = await import("./hostSendOrder");
    const run = requestHostDrain(path);
    expect(activeHostDrain(path)).toBe(run);
    await run;
    await vi.waitFor(() => expect(activeHostDrain(path)).toBeNull());
  });

  it("attaches one wake-up per in-flight send across repeated drains", async () => {
    const path = "/projects/once.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const send = beginHostSend(path, "live-once");
    let current = [cmd("live-once")];
    hostQueue.mockReset().mockImplementation(async () => current);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(path);
    await drainHostOfflineQueue(path);
    expect(hostQueue).toHaveBeenCalledTimes(2);
    current = [];
    send.finish();
    await vi.waitFor(() => expect(hostQueue).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(hostQueue).toHaveBeenCalledTimes(3);
  });

  it("wakes each project's drain for its own in-flight send, even with a shared command id", async () => {
    const pathA = "/projects/twin-a.project.json";
    const pathB = "/projects/twin-b.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const sendA = beginHostSend(pathA, "twin");
    const sendB = beginHostSend(pathB, "twin");
    const queues = new Map<string, QueuedCommand[]>([
      [pathA, [cmd("twin")]],
      [pathB, [cmd("twin")]],
    ]);
    hostQueue
      .mockReset()
      .mockImplementation(async (p: string) => queues.get(p) ?? []);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(pathA);
    await drainHostOfflineQueue(pathB);
    queues.set(pathA, []);
    queues.set(pathB, []);
    sendA.finish();
    sendB.finish();
    const reads = (p: string) =>
      hostQueue.mock.calls.filter((c) => c[0] === p).length;
    await vi.waitFor(() => {
      expect(reads(pathA)).toBe(2);
      expect(reads(pathB)).toBe(2);
    });
  });

  it("stops at this tab's in-flight send and drains again once it settles", async () => {
    const path = "/projects/episode.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const send = beginHostSend(path, "live");
    let current = [cmd("live"), cmd("later")];
    hostQueue.mockImplementation(async () => current);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(path);
    expect(submit).not.toHaveBeenCalled();
    current = [cmd("later")];
    send.finish();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][3]).toMatchObject({
      command_id: "later",
      replaying: true,
    });
  });

  it("skips a record a live send dequeued while an earlier one replayed", async () => {
    const path = "/projects/episode.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const liveA = beginHostSend(path, "a");
    let current = [cmd("x"), cmd("a"), cmd("b")];
    hostQueue.mockImplementation(async () => current);
    submit.mockImplementationOnce(async () => {
      // The live send of "a" commits and dequeues itself while "x" replays.
      current = [cmd("x"), cmd("b")];
      liveA.finish();
      return { ok: true };
    });
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(path);
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["x", "b"]);
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(path, ["x", "b"]);
  });

  it("requestHostDrain runs one more pass when asked mid-drain", async () => {
    const path = "/projects/episode.project.json";
    let current = [cmd("x")];
    hostQueue.mockImplementation(async () => current);
    removeHostQueuedCommands.mockImplementation(
      async (_p: string, ids: string[]) => {
        current = current.filter((c) => !ids.includes(c.command_id));
      },
    );
    let releaseX!: () => void;
    submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseX = () => resolve({ ok: true });
        }),
    );
    const { requestHostDrain } = await import("./drainOfflineQueue");
    const first = requestHostDrain(path);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    current = [...current, cmd("b")];
    const second = requestHostDrain(path);
    releaseX();
    await Promise.all([first, second]);
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["x", "b"]);
  });

  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ok: true });
    hostQueue.mockReset();
    guestQueue.mockReset();
    removeHostQueuedCommands.mockReset().mockResolvedValue(undefined);
  });

  it("replays only the host bucket, in insertion order rather than client_seq order", async () => {
    hostQueue.mockResolvedValue([
      {
        command_id: "first",
        client_seq: 2,
        type: "SetTrackMeta",
        payload: { label: "A" },
        created_at: 1,
      },
      {
        command_id: "second",
        client_seq: 1,
        type: "SetTrackMeta",
        payload: { label: "B" },
        created_at: 2,
      },
    ]);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue("/projects/episode.project.json");

    expect(guestQueue).not.toHaveBeenCalled();
    expect(submit.mock.calls).toEqual([
      [
        "/projects/episode.project.json",
        "SetTrackMeta",
        { label: "A" },
        expect.objectContaining({
          command_id: "first",
          client_seq: 2,
          replaying: true,
        }),
      ],
      [
        "/projects/episode.project.json",
        "SetTrackMeta",
        { label: "B" },
        expect.objectContaining({
          command_id: "second",
          client_seq: 1,
          replaying: true,
        }),
      ],
    ]);
    expect(removeHostQueuedCommands).toHaveBeenCalledOnce();
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(
      "/projects/episode.project.json",
      ["first", "second"],
    );
  });

  it("removes a long successful replay in one storage update", async () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      command_id: `command-${index}`,
      client_seq: index + 1,
      type: "SetTrackMeta",
      payload: {},
      created_at: index,
    }));
    hostQueue.mockResolvedValue(commands);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue("/projects/episode.project.json");

    expect(submit).toHaveBeenCalledTimes(100);
    expect(hostQueue).toHaveBeenCalledTimes(1);
    expect(removeHostQueuedCommands).toHaveBeenCalledOnce();
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(
      "/projects/episode.project.json",
      commands.map((command) => command.command_id),
    );
  });

  it("applies two queued same-track envelope edits in order", async () => {
    type Point = { id: string; time: number; value: number };
    let hostPoints: Point[] = [{ id: "a", time: 0, value: 1 }];
    const snapshot = [...hostPoints];
    const edit = (id: string, value: number): QueuedCommand => ({
      command_id: id,
      client_seq: 1,
      type: "SetEnvelope",
      payload: {
        track_id: "host",
        points: [{ id: "a", time: 0, value }],
        expected_points: snapshot,
      },
      created_at: 0,
    });
    // Both edits were made offline from the same stale store snapshot.
    const queue: QueuedCommand[] = [];
    for (const cmd of [edit("first", 0.5), edit("second", 0.25)]) {
      queue.push(chainQueuedEnvelopeBaseline(queue, cmd));
    }
    hostQueue.mockResolvedValue(queue);
    submit.mockImplementation(
      async (
        _path: string,
        _type: string,
        payload: Record<string, unknown>,
      ) => {
        if (
          JSON.stringify(payload.expected_points) !== JSON.stringify(hostPoints)
        ) {
          throw new ApiError("Envelope changed", null, 409);
        }
        hostPoints = payload.points as Point[];
        return { ok: true };
      },
    );
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue("/projects/episode.project.json");

    expect(hostPoints).toEqual([{ id: "a", time: 0, value: 0.25 }]);
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(
      "/projects/episode.project.json",
      ["first", "second"],
    );
  });

  it("still removes replayed records when a queue re-read fails", async () => {
    const path = "/projects/episode.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const liveB = beginHostSend(path, "b");
    let unreadable = false;
    hostQueue.mockImplementation(async () => {
      if (unreadable) throw new Error("idb");
      return [cmd("a"), cmd("b")];
    });
    submit.mockImplementationOnce(async () => {
      // The live send of "b" finishes while "a" replays, then IndexedDB fails.
      liveB.finish();
      unreadable = true;
      return { ok: true };
    });
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await expect(drainHostOfflineQueue(path)).resolves.toBeUndefined();
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a"]);
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(path, ["a"]);
  });

  it("does not re-read the queue for live sends that began after the snapshot", async () => {
    const path = "/projects/steady.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    hostQueue.mockResolvedValue([cmd("x"), cmd("y"), cmd("z")]);
    submit.mockImplementation(async () => {
      beginHostSend(path, `new-${submit.mock.calls.length}`).finish();
      return { ok: true };
    });
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(path);
    expect(hostQueue).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("re-reads when a live send finished while the snapshot loaded", async () => {
    const path = "/projects/during-load.project.json";
    const { beginHostSend } = await import("./hostSendOrder");
    const liveA = beginHostSend(path, "a");
    hostQueue
      .mockImplementationOnce(async () => {
        liveA.finish();
        return [cmd("a"), cmd("b")];
      })
      .mockImplementation(async () => [cmd("b")]);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await drainHostOfflineQueue(path);
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["b"]);
  });

  it("replays another tab's in-flight record with its original identity", async () => {
    const path = "/projects/episode.project.json";
    // Another tab is still POSTing "foreign"; this tab's registry does not know it.
    hostQueue.mockResolvedValue([
      {
        command_id: "foreign",
        client_id: "other-tab",
        client_seq: 7,
        type: "SetTrackMeta",
        payload: { label: "A" },
        created_at: 1,
      },
      cmd("mine"),
    ]);
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue(path);

    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual([
      "foreign",
      "mine",
    ]);
    expect(submit.mock.calls[0][3]).toMatchObject({
      command_id: "foreign",
      client_id: "other-tab",
      client_seq: 7,
      replaying: true,
    });
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(path, [
      "foreign",
      "mine",
    ]);
  });
});

describe("drainOfflineQueue (guest)", () => {
  const queued = (id: string, seq: number): QueuedCommand => ({
    command_id: id,
    client_seq: seq,
    type: "SetTrackFader",
    payload: { track_id: "host", fader_db: -seq },
    created_at: seq,
  });

  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ok: true });
    guestQueue.mockReset();
  });

  it("replays in client_seq order, not storage order", async () => {
    guestQueue.mockResolvedValue([
      queued("c", 3),
      queued("a", 1),
      queued("b", 2),
      queued("d", 4),
    ]);
    const { drainOfflineQueue } = await import("./drainOfflineQueue");

    await drainOfflineQueue("tok");

    expect(submit.mock.calls.map((call) => call[3].command_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    for (const call of submit.mock.calls) {
      expect(call[3]).toMatchObject({ replaying: true });
    }
  });

  it("requestGuestDrain coalesces overlapping requests into one more pass", async () => {
    guestQueue.mockResolvedValue([queued("a", 1)]);
    let release: () => void = () => undefined;
    submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const { requestGuestDrain } = await import("./drainOfflineQueue");
    const first = requestGuestDrain("tok");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const second = requestGuestDrain("tok");
    const third = requestGuestDrain("tok");
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;
    expect(guestQueue).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

const HOST_PATH = "/projects/parity.project.json";

// These rows pin the shared driver contract through a mocked
// submitDocumentCommand. They cannot see the submit layers' asymmetry: a host
// replay transport failure or 5xx returns `{queued: true}`, while a guest
// replay throws. drainOfflineQueue.integration.test.ts and
// api.documentCommand.test.ts cover the real submit layers.
describe.each([
  {
    name: "host",
    queue: () => hostQueue,
    drain: async () =>
      (await import("./drainOfflineQueue")).drainHostOfflineQueue(HOST_PATH),
    path: HOST_PATH,
  },
  {
    name: "guest",
    queue: () => guestQueue,
    drain: async () =>
      (await import("./drainOfflineQueue")).drainOfflineQueue("parity"),
    path: shareProjectKey("parity"),
  },
])("replay contract ($name)", ({ name, queue, drain, path }) => {
  const rec = (id: string, seq: number): QueuedCommand => ({
    command_id: id,
    client_id: "tab-1",
    client_seq: seq,
    type: "SetTrackMeta",
    payload: { label: id },
    created_at: seq,
  });

  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ok: true });
    hostQueue.mockReset();
    guestQueue.mockReset();
    removeHostQueuedCommands.mockReset().mockResolvedValue(undefined);
  });

  it("replays every record in order with its original identity", async () => {
    queue().mockResolvedValue([rec("a", 1), rec("b", 2), rec("c", 3)]);

    await drain();

    expect(submit.mock.calls.map((c) => c[0])).toEqual([path, path, path]);
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    for (const [callPath, type, payload, identity] of submit.mock.calls) {
      const id = identity.command_id as string;
      expect(callPath).toBe(path);
      expect(type).toBe("SetTrackMeta");
      expect(payload).toEqual({ label: id });
      expect(identity).toMatchObject({
        command_id: id,
        client_id: "tab-1",
        client_seq: { a: 1, b: 2, c: 3 }[id],
        replaying: true,
      });
    }
    if (name === "host") {
      expect(removeHostQueuedCommands).toHaveBeenCalledTimes(1);
      expect(removeHostQueuedCommands).toHaveBeenCalledWith(HOST_PATH, [
        "a",
        "b",
        "c",
      ]);
    } else {
      expect(removeHostQueuedCommands).not.toHaveBeenCalled();
    }
  });

  it.each([403, 409, 422])(
    "skips a refused %i record and keeps replaying",
    async (status) => {
      queue().mockResolvedValue([rec("a", 1), rec("b", 2), rec("c", 3)]);
      submit
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new ApiError("Refused", null, status))
        .mockResolvedValueOnce({ ok: true });

      await drain();

      expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual([
        "a",
        "b",
        "c",
      ]);
      if (name === "host") {
        expect(removeHostQueuedCommands).toHaveBeenCalledTimes(1);
        expect(removeHostQueuedCommands).toHaveBeenCalledWith(HOST_PATH, [
          "a",
          "c",
        ]);
      } else {
        expect(removeHostQueuedCommands).not.toHaveBeenCalled();
      }
    },
  );

  it("stops at a transport error without leapfrogging", async () => {
    queue().mockResolvedValue([rec("a", 1), rec("b", 2), rec("c", 3)]);
    submit.mockRejectedValueOnce(new Error("offline"));

    await drain();

    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a"]);
    if (name === "host") {
      expect(removeHostQueuedCommands).toHaveBeenCalledTimes(1);
      expect(removeHostQueuedCommands).toHaveBeenCalledWith(HOST_PATH, []);
    } else {
      expect(removeHostQueuedCommands).not.toHaveBeenCalled();
    }
  });

  it.each([408, 429])(
    "stops at a retry-later %i and keeps it for the next drain",
    async (status) => {
      queue().mockResolvedValue([rec("a", 1), rec("b", 2), rec("c", 3)]);
      submit
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new ApiError("Slow down", null, status));

      await drain();

      expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a", "b"]);
      if (name === "host") {
        expect(removeHostQueuedCommands).toHaveBeenCalledTimes(1);
        expect(removeHostQueuedCommands).toHaveBeenCalledWith(HOST_PATH, ["a"]);
      } else {
        expect(removeHostQueuedCommands).not.toHaveBeenCalled();
      }
    },
  );

  it("stops when the submit layer leaves a replay queued", async () => {
    // Driver contract only for the guest row: the real guest submit layer
    // throws on a failed replay and never returns `queued`.
    queue().mockResolvedValue([rec("a", 1), rec("b", 2), rec("c", 3)]);
    submit.mockResolvedValueOnce({ ok: true, queued: true });

    await drain();

    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a"]);
    if (name === "host") {
      expect(removeHostQueuedCommands).toHaveBeenCalledTimes(1);
      expect(removeHostQueuedCommands).toHaveBeenCalledWith(HOST_PATH, []);
    } else {
      expect(removeHostQueuedCommands).not.toHaveBeenCalled();
    }
  });
});

describe("replayQueuedCommands", () => {
  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ok: true });
    hostQueue.mockReset();
    guestQueue.mockReset();
    removeHostQueuedCommands.mockReset().mockResolvedValue(undefined);
  });

  const rec = (id: string): QueuedCommand => ({
    command_id: id,
    client_seq: 1,
    type: "SetTrackMeta",
    payload: {},
    created_at: 0,
  });

  it("sends only records the gate allows and settles with the committed ids", async () => {
    const { replayQueuedCommands } = await import("./drainOfflineQueue");
    const settle = vi.fn();
    const queue = [rec("a"), rec("b"), rec("c"), rec("d")];
    await replayQueuedCommands({
      path: "/projects/driver.project.json",
      load: async () => queue,
      gate: async (cmd) => {
        if (cmd.command_id === "b") return "skip";
        if (cmd.command_id === "d") return "stop";
        return "send";
      },
      settle,
    });

    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a", "c"]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(["a", "c"]);
  });

  it("defaults the gate to send and continues past a permanent rejection", async () => {
    const { replayQueuedCommands } = await import("./drainOfflineQueue");
    const queue = [rec("a"), rec("b"), rec("c"), rec("d")];
    submit.mockRejectedValueOnce(new ApiError("x", null, 403));
    await replayQueuedCommands({
      path: "/projects/driver.project.json",
      load: async () => queue,
    });

    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
