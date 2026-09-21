import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
