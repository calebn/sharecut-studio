import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HOST_KEY } from "./http";
import { openJobStream } from "./jobStream";
import { retryPipelineJob, waitForPipelineJob } from "./pipeline";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

vi.mock("./jobStream", () => ({
  openJobStream: vi.fn(() => {
    throw new Error("A terminal status lookup must not open a stream");
  }),
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

describe("waitForPipelineJob exact terminal lookup", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(openJobStream).mockClear();
  });

  it.each(
    ["running", "ok"].flatMap((primaryStatus) =>
      ["ok", "error", "cancelled"].map((status) => ({ primaryStatus, status })),
    ),
  )(
    "returns $status B from jobs when $primaryStatus J is primary",
    async ({ primaryStatus, status }) => {
      const b = {
        id: "B",
        retry_of: "A",
        kind: "pipeline",
        project_path: "/tmp/p.json",
        status,
        error_code: status === "error" ? "model_needed" : null,
        error_model: status === "error" ? { id: "word-aligner" } : null,
      };
      const j = { id: "J", kind: "agent", status: primaryStatus };
      vi.mocked(apiFetch).mockResolvedValue(
        Response.json({
          running: primaryStatus === "running",
          job: j,
          jobs: [j, b],
          running_count: primaryStatus === "running" ? 1 : 0,
        }),
      );
      const controller = new AbortController();
      await expect(
        waitForPipelineJob("B", { signal: controller.signal }),
      ).resolves.toEqual(b);
      expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
        HOST_KEY,
        { host: "/api/pipeline/status" },
        { signal: undefined },
      );
      expect(openJobStream).not.toHaveBeenCalled();
    },
  );
});
