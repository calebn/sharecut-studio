import { describe, expect, it, vi } from "vitest";

const requestHostDrain = vi.fn();
const requestGuestDrain = vi.fn();
vi.mock("./drainOfflineQueue", () => ({ requestHostDrain, requestGuestDrain }));

describe("lazy drain requests", () => {
  it("requests a host drain for the project", async () => {
    requestHostDrain.mockResolvedValue(undefined);
    const { requestHostDrainLazy } = await import("./requestDrainLazy");
    requestHostDrainLazy("/tmp/episode.project.json");
    await vi.waitFor(() =>
      expect(requestHostDrain).toHaveBeenCalledWith(
        "/tmp/episode.project.json",
      ),
    );
  });

  it("swallows a failed host drain request", async () => {
    requestHostDrain.mockReset().mockRejectedValue(new Error("boom"));
    const { requestHostDrainLazy } = await import("./requestDrainLazy");
    expect(() => requestHostDrainLazy("/tmp/b.project.json")).not.toThrow();
    await vi.waitFor(() =>
      expect(requestHostDrain).toHaveBeenCalledWith("/tmp/b.project.json"),
    );
  });

  it("replays the guest queue for the token", async () => {
    requestGuestDrain.mockResolvedValue(undefined);
    const { requestGuestDrainLazy } = await import("./requestDrainLazy");
    requestGuestDrainLazy("tok");
    await vi.waitFor(() =>
      expect(requestGuestDrain).toHaveBeenCalledWith("tok"),
    );
  });

  it("swallows a failed guest drain", async () => {
    requestGuestDrain.mockReset().mockRejectedValue(new Error("boom"));
    const { requestGuestDrainLazy } = await import("./requestDrainLazy");
    expect(() => requestGuestDrainLazy("tok2")).not.toThrow();
    await vi.waitFor(() =>
      expect(requestGuestDrain).toHaveBeenCalledWith("tok2"),
    );
  });
});
