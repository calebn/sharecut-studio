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

describe("drainHostOfflineQueue", () => {
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
});
