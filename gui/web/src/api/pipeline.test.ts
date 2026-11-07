import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HOST_KEY } from "./http";
import { retryPipelineJob } from "./pipeline";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

describe("retryPipelineJob", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("sends only the original host job reference and returns the accepted successor", async () => {
    const successor = { id: "accepted", kind: "pipeline", status: "running" };
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ job: successor }));
    await expect(
      retryPipelineJob("/tmp/episode.sharecut", "original"),
    ).resolves.toEqual(successor);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
      HOST_KEY,
      { host: "/api/pipeline/retry" },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/tmp/episode.sharecut",
          job_id: "original",
        }),
      },
    );
  });

  it("refuses share guests before making a request", async () => {
    await expect(retryPipelineJob("share:guest", "original")).rejects.toThrow(
      "not available for shared guests",
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("preserves a refused request instead of adopting a fabricated job", async () => {
    const refused = new Error("The project changed.");
    vi.mocked(apiFetch).mockRejectedValue(refused);
    await expect(
      retryPipelineJob("/tmp/episode.sharecut", "original"),
    ).rejects.toBe(refused);
  });
});
