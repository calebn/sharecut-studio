import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeaksFetchResult } from "../types/project";

const { loadPeaksMock } = vi.hoisted(() => ({
  loadPeaksMock:
    vi.fn<
      (projectPath: string, trackId: string) => Promise<PeaksFetchResult>
    >(),
}));

vi.mock("../api", () => ({
  loadPeaks: loadPeaksMock,
}));

import {
  PEAKS_RETRY_BASE_MS,
  PEAKS_RETRY_MAX_MS,
  peaksRetryDelayMs,
  usePeaks,
} from "./usePeaks";

const READY: PeaksFetchResult = {
  status: "ready",
  peaks: { peaks: [1, 2, 3], samples_per_pixel: 500, sample_rate: 8000 },
};
const GENERATING: PeaksFetchResult = { status: "generating" };
const UNAVAILABLE: PeaksFetchResult = { status: "unavailable" };

let projectSeq = 0;
/** Unique project path per test; the module-level ready cache is keyed by it. */
const nextProject = () => `/tmp/peaks-${++projectSeq}.json`;

describe("peaksRetryDelayMs", () => {
  it("doubles from the base delay and caps at the max", () => {
    expect(peaksRetryDelayMs(0)).toBe(PEAKS_RETRY_BASE_MS);
    expect(peaksRetryDelayMs(1)).toBe(PEAKS_RETRY_BASE_MS * 2);
    expect(peaksRetryDelayMs(2)).toBe(PEAKS_RETRY_BASE_MS * 4);
    expect(peaksRetryDelayMs(10)).toBe(PEAKS_RETRY_MAX_MS);
  });
});

describe("usePeaks", () => {
  afterEach(() => {
    loadPeaksMock.mockReset();
    vi.useRealTimers();
  });

  it("does not cache an unavailable result across mounts", async () => {
    const project = nextProject();
    loadPeaksMock.mockResolvedValue(UNAVAILABLE);
    const first = renderHook(() => usePeaks(project, "host", true, "v1"));
    await waitFor(() =>
      expect(first.result.current.status).toBe("unavailable"),
    );
    first.unmount();

    const calls = loadPeaksMock.mock.calls.length;
    const second = renderHook(() => usePeaks(project, "host", true, "v1"));
    await waitFor(() =>
      expect(loadPeaksMock.mock.calls.length).toBeGreaterThan(calls),
    );
    await waitFor(() =>
      expect(second.result.current.status).toBe("unavailable"),
    );
  });

  it("polls while generating and settles on ready", async () => {
    vi.useFakeTimers();
    const project = nextProject();
    loadPeaksMock
      .mockResolvedValueOnce(GENERATING)
      .mockResolvedValueOnce(GENERATING)
      .mockResolvedValueOnce(READY);

    const { result } = renderHook(() => usePeaks(project, "host", true, "v1"));

    await vi.waitFor(() => expect(result.current.status).toBe("generating"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEAKS_RETRY_BASE_MS);
    });
    expect(result.current.status).toBe("generating");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(peaksRetryDelayMs(1));
    });
    expect(result.current.status).toBe("ready");
    expect(Array.from(result.current.peaks?.peaks ?? [])).toEqual([1, 2, 3]);
  });

  it("caches ready results per version, and a version change refetches", async () => {
    const project = nextProject();
    loadPeaksMock.mockResolvedValue(READY);
    const { result, rerender } = renderHook(
      ({ version }: { version: string }) =>
        usePeaks(project, "host", true, version),
      { initialProps: { version: "v1" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loadPeaksMock).toHaveBeenCalledTimes(1);

    rerender({ version: "v1" });
    expect(result.current.status).toBe("ready");
    expect(loadPeaksMock).toHaveBeenCalledTimes(1);

    rerender({ version: "v2" });
    await waitFor(() => expect(loadPeaksMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("stays idle and makes no request when disabled", () => {
    const project = nextProject();
    const { result } = renderHook(() => usePeaks(project, "host", false, "v1"));
    expect(result.current).toEqual({ peaks: null, status: "idle" });
    expect(loadPeaksMock).not.toHaveBeenCalled();
  });

  it("stops polling once unmounted", async () => {
    vi.useFakeTimers();
    const project = nextProject();
    loadPeaksMock.mockResolvedValue(GENERATING);
    const { result, unmount } = renderHook(() =>
      usePeaks(project, "host", true, "v1"),
    );
    await vi.waitFor(() => expect(result.current.status).toBe("generating"));
    const callsBeforeUnmount = loadPeaksMock.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEAKS_RETRY_MAX_MS * 2);
    });
    expect(loadPeaksMock.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("keeps polling while generating, however long the queue", async () => {
    vi.useFakeTimers();
    const project = nextProject();
    for (let i = 0; i < 40; i += 1) {
      loadPeaksMock.mockResolvedValueOnce(GENERATING);
    }
    loadPeaksMock.mockResolvedValueOnce(READY);
    const { result } = renderHook(() => usePeaks(project, "host", true, "v1"));
    await vi.waitFor(() => expect(result.current.status).toBe("generating"));
    for (let i = 0; i < 40; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PEAKS_RETRY_MAX_MS);
      });
    }
    expect(result.current.status).toBe("ready");
    expect(loadPeaksMock).toHaveBeenCalledTimes(41);
  });

  it("settles on unavailable only when the server stops generating", async () => {
    vi.useFakeTimers();
    const project = nextProject();
    loadPeaksMock
      .mockResolvedValueOnce(GENERATING)
      .mockResolvedValueOnce(UNAVAILABLE);
    const { result } = renderHook(() => usePeaks(project, "host", true, "v1"));
    await vi.waitFor(() => expect(result.current.status).toBe("generating"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEAKS_RETRY_BASE_MS);
    });
    expect(result.current.status).toBe("unavailable");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEAKS_RETRY_MAX_MS * 2);
    });
    expect(loadPeaksMock).toHaveBeenCalledTimes(2);
  });
});
