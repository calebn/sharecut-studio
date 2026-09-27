import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("replays only the host bucket in client sequence order with identity", async () => {
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

  it("does not leapfrog a failed command", async () => {
    hostQueue.mockResolvedValue([
      {
        command_id: "first",
        client_seq: 1,
        type: "A",
        payload: {},
        created_at: 1,
      },
      {
        command_id: "second",
        client_seq: 2,
        type: "B",
        payload: {},
        created_at: 2,
      },
    ]);
    submit.mockRejectedValueOnce(new Error("offline"));
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue("/projects/episode.project.json");

    expect(submit).toHaveBeenCalledTimes(1);
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(
      "/projects/episode.project.json",
      [],
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

  it("keeps draining unrelated edits after a recorded conflict", async () => {
    hostQueue.mockResolvedValue([
      {
        command_id: "stale",
        client_seq: 1,
        type: "SetEnvelope",
        payload: {},
        created_at: 1,
      },
      {
        command_id: "meta",
        client_seq: 2,
        type: "SetTrackMeta",
        payload: {},
        created_at: 2,
      },
    ]);
    submit.mockRejectedValueOnce(new ApiError("Envelope changed", null, 409));
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");

    await drainHostOfflineQueue("/projects/episode.project.json");

    expect(submit).toHaveBeenCalledTimes(2);
    // The conflict dequeued itself inside submitDocumentCommand.
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(
      "/projects/episode.project.json",
      ["meta"],
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
    const other = beginHostSend(path, "other");
    let unreadable = false;
    hostQueue.mockImplementation(async () => {
      if (unreadable) throw new Error("idb");
      return [cmd("a"), cmd("b")];
    });
    submit.mockImplementationOnce(async () => {
      // A live send finishes while "a" replays, then IndexedDB fails.
      other.finish();
      unreadable = true;
      return { ok: true };
    });
    const { drainHostOfflineQueue } = await import("./drainOfflineQueue");
    await expect(drainHostOfflineQueue(path)).resolves.toBeUndefined();
    expect(submit.mock.calls.map((c) => c[3].command_id)).toEqual(["a"]);
    expect(removeHostQueuedCommands).toHaveBeenCalledWith(path, ["a"]);
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

  it("replays in order, skips a refused edit and stops at a rate limit", async () => {
    guestQueue.mockResolvedValue([
      queued("c", 3),
      queued("a", 1),
      queued("b", 2),
      queued("d", 4),
    ]);
    submit
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new ApiError("Not allowed", null, 403))
      .mockRejectedValueOnce(new ApiError("Slow down", null, 429));
    const { drainOfflineQueue } = await import("./drainOfflineQueue");

    await drainOfflineQueue("tok");

    expect(submit.mock.calls.map((call) => call[3].command_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    for (const call of submit.mock.calls) {
      expect(call[3]).toMatchObject({ replaying: true });
    }
  });
});
