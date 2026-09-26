import { describe, expect, it, vi } from "vitest";

const requestHostDrain = vi.fn();
vi.mock("./drainOfflineQueue", () => ({ requestHostDrain }));

describe("requestHostDrainLazy", () => {
  it("requests a drain for the project", async () => {
    requestHostDrain.mockResolvedValue(undefined);
    const { requestHostDrainLazy } = await import("./requestHostDrainLazy");
    requestHostDrainLazy("/tmp/episode.project.json");
    await vi.waitFor(() =>
      expect(requestHostDrain).toHaveBeenCalledWith(
        "/tmp/episode.project.json",
      ),
    );
  });

  it("swallows a failed drain request", async () => {
    requestHostDrain.mockReset().mockRejectedValue(new Error("boom"));
    const { requestHostDrainLazy } = await import("./requestHostDrainLazy");
    expect(() => requestHostDrainLazy("/tmp/b.project.json")).not.toThrow();
    await vi.waitFor(() =>
      expect(requestHostDrain).toHaveBeenCalledWith("/tmp/b.project.json"),
    );
  });
});
