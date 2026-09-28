import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const runBootstrap = vi.fn();
const waitForBootstrapJob = vi.fn();

vi.mock("../api", () => ({
  runBootstrap: (...args: unknown[]) => runBootstrap(...args),
  waitForBootstrapJob: (...args: unknown[]) => waitForBootstrapJob(...args),
}));

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

    const { result } = renderHook(() => useBootstrapDownload());
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

  it("resolves false with an error and clears busy on failure", async () => {
    runBootstrap.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useBootstrapDownload());
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

    const { result } = renderHook(() => useBootstrapDownload());
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
    const { result } = renderHook(() => useBootstrapDownload());
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
});
