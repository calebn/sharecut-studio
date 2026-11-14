import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HOST_KEY } from "./http";
import { openJobStream } from "./jobStream";
import {
  loadTranscriptLanguageStatus,
  retryPipelineJob,
  waitForPipelineJob,
} from "./pipeline";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

vi.mock("./jobStream", () => ({
  openJobStream: vi.fn(() => {
    throw new Error("A terminal status lookup must not open a stream");
  }),
}));

describe("loadTranscriptLanguageStatus", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("asks for the staged language and returns the answer as sent", async () => {
    const body = {
      language: "es",
      stale_tracks: [{ track_id: "host", name: "Priya", recorded: "en" }],
      edited_stale_tracks: [],
    };
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    await expect(
      loadTranscriptLanguageStatus("/p/ep.json", "es"),
    ).resolves.toEqual(body);
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/transcript/language-status?path=%2Fp%2Fep.json&language=es",
    });
  });

  it("sends no language for auto", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await loadTranscriptLanguageStatus("/p/ep.json", null);
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/transcript/language-status?path=%2Fp%2Fep.json",
    });
  });

  it("refuses share guests before making a request", async () => {
    await expect(
      loadTranscriptLanguageStatus("share:tok", "es"),
    ).rejects.toThrow("not available for shared guests");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

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
        { signal: expect.any(AbortSignal) },
      );
      expect(controller.signal.aborted).toBe(false);
      expect(openJobStream).not.toHaveBeenCalled();
    },
  );
});

describe("waitForPipelineJob initial request lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(openJobStream).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const terminal = { id: "B", kind: "pipeline", status: "ok" };
  function heldStatus() {
    let release!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      release = resolve;
    });
    return { request, release };
  }
  function track(promise: Promise<unknown>) {
    const state = {
      kind: "pending" as "pending" | "ok" | "error",
      error: undefined as unknown,
    };
    const finished = promise.then(
      () => {
        state.kind = "ok";
      },
      (error: unknown) => {
        state.kind = "error";
        state.error = error;
      },
    );
    return { state, finished };
  }

  it("aborts while status is held and ignores its late response", async () => {
    const held = heldStatus();
    vi.mocked(apiFetch).mockReturnValueOnce(held.request);
    const controller = new AbortController();
    const pending = track(
      waitForPipelineJob("B", { signal: controller.signal }),
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const stateAtAbort = pending.state.kind;
    held.release(Response.json({ job: terminal }));
    await pending.finished;
    expect(stateAtAbort).toBe("error");
    expect(pending.state.error).toMatchObject({ name: "AbortError" });
    expect(vi.mocked(apiFetch).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(openJobStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out while status is held and ignores its late response", async () => {
    const held = heldStatus();
    vi.mocked(apiFetch).mockReturnValueOnce(held.request);
    const pending = track(waitForPipelineJob("B", { timeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(50);
    const stateAtDeadline = pending.state.kind;
    held.release(Response.json({ job: terminal }));
    await pending.finished;
    expect(stateAtDeadline).toBe("error");
    expect(pending.state.error).toMatchObject({
      message: "Timed out waiting for job",
    });
    expect(vi.mocked(apiFetch).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(openJobStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after an exact terminal status", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ job: terminal }));
    await expect(waitForPipelineJob("B", { timeoutMs: 50 })).resolves.toEqual(
      terminal,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(openJobStream).not.toHaveBeenCalled();
  });

  it("keeps successive StrictMode-style caller signals independent", async () => {
    const first = heldStatus();
    const second = heldStatus();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(first.request)
      .mockReturnValueOnce(second.request);
    const retired = new AbortController();
    const active = new AbortController();
    const oldWait = track(waitForPipelineJob("B", { signal: retired.signal }));
    retired.abort();
    await vi.advanceTimersByTimeAsync(0);
    const retiredState = oldWait.state.kind;
    const newWait = waitForPipelineJob("B", { signal: active.signal });
    first.release(Response.json({ job: terminal }));
    second.release(Response.json({ job: terminal }));
    await oldWait.finished;
    await expect(newWait).resolves.toEqual(terminal);
    expect(retiredState).toBe("error");
    expect(oldWait.state.error).toMatchObject({ name: "AbortError" });
    expect(active.signal.aborted).toBe(false);
    expect(openJobStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
