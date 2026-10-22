import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const runBootstrap = vi.fn();
const waitForBootstrapJob = vi.fn();

vi.mock("../api", () => ({
  runBootstrap: (...args: unknown[]) => runBootstrap(...args),
  waitForBootstrapJob: (...args: unknown[]) => waitForBootstrapJob(...args),
}));

import { ApiError } from "../utils/apiError";
import { useBootstrapDownload } from "./useBootstrapDownload";

describe("useBootstrapDownload", () => {
  it("succeeds, keeps busy true, and tracks progress from onUpdate", async () => {
    runBootstrap.mockResolvedValue({
      job: { id: "job1", status: "running", message: "Starting…" },
    });
    let resolveJob!: (job: unknown) => void;
    waitForBootstrapJob.mockImplementation(
      (_id: string, opts?: { onUpdate?: (job: unknown) => void }) =>
        new Promise((resolve) => {
          resolveJob = (job: unknown) => {
            opts?.onUpdate?.(job);
            resolve(job);
          };
        }),
    );

    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    expect(result.current.busy).toBe(false);

    let downloadPromise!: Promise<boolean>;
    act(() => {
      downloadPromise = result.current.download({
        components: ["word-aligner"],
      });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    act(() => {
      resolveJob({ id: "job1", status: "ok", message: "Fetching weights…" });
    });
    await waitFor(() =>
      expect(result.current.progress).toBe("Fetching weights…"),
    );

    expect(await downloadPromise).toBe(true);
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it.each(["error", "cancelled"])(
    "resolves false with the job's message when the job ends %s",
    async (status) => {
      runBootstrap.mockResolvedValue({
        job: { id: "job1", status: "running" },
      });
      waitForBootstrapJob.mockResolvedValue({
        id: "job1",
        status,
        error: status === "error" ? "The download server is busy." : null,
        message: "Stopped",
      });
      const { result } = renderHook(() =>
        useBootstrapDownload("the word aligner"),
      );
      let outcome!: boolean;
      await act(async () => {
        outcome = await result.current.download({
          components: ["word-aligner"],
        });
      });
      expect(outcome).toBe(false);
      expect(result.current.busy).toBe(false);
      expect(result.current.error).toBe(
        status === "error" ? "The download server is busy." : "Stopped",
      );
    },
  );

  it("resolves false with an error and clears busy on failure", async () => {
    runBootstrap.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.download({ components: ["word-aligner"] });
    });

    expect(ok).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("network down");
  });

  it("ignores a second call while one is in flight", async () => {
    let resolveRun!: (v: { job: { id: string; status: string } }) => void;
    runBootstrap.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    waitForBootstrapJob.mockResolvedValue({ id: "job1", status: "ok" });

    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    let firstPromise!: Promise<boolean>;
    act(() => {
      firstPromise = result.current.download({ components: ["whisper"] });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    let secondOk!: boolean;
    await act(async () => {
      secondOk = await result.current.download({ components: ["whisper"] });
    });
    expect(secondOk).toBe(false);
    expect(runBootstrap).toHaveBeenCalledTimes(1);

    resolveRun({ job: { id: "job1", status: "running" } });
    await act(async () => {
      await firstPromise;
    });
  });

  it("reset clears busy, progress and error", async () => {
    runBootstrap.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    await act(async () => {
      await result.current.download({ components: ["word-aligner"] });
    });
    expect(result.current.error).toBe("boom");

    act(() => {
      result.current.reset();
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("hides env vars and paths behind a plain sentence naming the subject", async () => {
    runBootstrap.mockRejectedValue(
      new Error(
        "word-aligner: no download source: set PODCAST_BOOTSTRAP_CDN_BASE or place the file at /home/x/.cache/p/models/a/m.onnx",
      ),
    );
    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    await act(async () => {
      await result.current.download({ components: ["word-aligner"] });
    });
    expect(result.current.error).toBe(
      "Couldn't download the word aligner. Export diagnostics from the command palette and try again.",
    );
  });

  const SAFE =
    "Couldn't download the word aligner. Export diagnostics from the command palette and try again.";

  it("clears raw progress text when the job fails", async () => {
    const raw =
      "speaker-ecapa: speaker-ecapa has no sha256 pin in bootstrap-assets.json";
    runBootstrap.mockResolvedValue({
      job: { id: "job1", status: "running", message: "Starting…" },
    });
    waitForBootstrapJob.mockImplementation(
      async (
        _id: string,
        opts?: { onUpdate?: (job: { message: string }) => void },
      ) => {
        opts?.onUpdate?.({ message: raw });
        throw new Error(raw);
      },
    );
    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    await act(async () => {
      await result.current.download({ components: ["speaker-ecapa"] });
    });

    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBe(SAFE);
  });

  it.each([
    "speaker-ecapa: speaker-ecapa has no sha256 pin in bootstrap-assets.json",
    "word-aligner: sha256 mismatch for model.onnx: expected abc, got def",
    "whisper: model tiny not found",
  ])("hides a component-id lead: %s", async (raw) => {
    runBootstrap.mockRejectedValue(new Error(raw));
    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    await act(async () => {
      await result.current.download({ components: ["word-aligner"] });
    });
    expect(result.current.error).toBe(SAFE);
  });

  it.each(["network down", "Bootstrap failed"])(
    "passes a clean message through: %s",
    async (raw) => {
      runBootstrap.mockRejectedValue(new Error(raw));
      const { result } = renderHook(() =>
        useBootstrapDownload("the word aligner"),
      );
      await act(async () => {
        await result.current.download({ components: ["word-aligner"] });
      });
      expect(result.current.error).toBe(raw);
    },
  );

  it("shows one sentence without a component id when another download is running", async () => {
    runBootstrap.mockRejectedValue(
      new ApiError(
        "Another download is already running (whisper); try again when it finishes",
        "bootstrap_job_running",
        409,
      ),
    );
    const { result } = renderHook(() =>
      useBootstrapDownload("the word aligner"),
    );
    await act(async () => {
      await result.current.download({ components: ["word-aligner"] });
    });
    expect(result.current.error).toBe(
      "Another download is already running. Try again when it finishes.",
    );
  });
});
