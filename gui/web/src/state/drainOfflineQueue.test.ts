import { beforeEach, describe, expect, it, vi } from "vitest";

const submit = vi.fn();
const hostQueue = vi.fn();
const guestQueue = vi.fn();

vi.mock("../api", () => ({ submitDocumentCommand: submit }));
vi.mock("./offlineStore", () => ({
  loadCommandQueue: guestQueue,
  loadHostCommandQueue: hostQueue,
}));

describe("drainHostOfflineQueue", () => {
  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ok: true });
    hostQueue.mockReset();
    guestQueue.mockReset();
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
  });
});
