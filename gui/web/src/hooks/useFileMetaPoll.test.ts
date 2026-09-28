import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMeta } from "./useFileMetaPoll";
import { SANITY_POLL_MS, useFileMetaPoll } from "./useFileMetaPoll";

describe("useFileMetaPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire onChange on the baseline read", async () => {
    const meta: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(meta);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    fetchMeta.mockResolvedValueOnce(meta);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onChange on a server_seq-only change", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    const next: FileMeta = { mtime_ns: 1, size: 10, server_seq: 2 };
    fetchMeta.mockResolvedValueOnce(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(next);

    fetchMeta.mockResolvedValueOnce(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("still fires onChange on an mtime change", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    const next: FileMeta = { mtime_ns: 2, size: 10, server_seq: 1 };
    fetchMeta.mockResolvedValueOnce(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("never fires onChange when the file does not exist", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    const missing: FileMeta = {
      mtime_ns: 9,
      size: 0,
      exists: false,
      server_seq: 0,
    };
    fetchMeta.mockResolvedValueOnce(missing);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a tick without server_seq (document.db read error)", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 5 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 1, size: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 1, size: 10, server_seq: 5 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("still fires on a real seq change after a read-error tick", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 5 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 1, size: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const next: FileMeta = { mtime_ns: 1, size: 10, server_seq: 6 };
    fetchMeta.mockResolvedValueOnce(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(next);
  });

  it("baselines server_seq from the first reading that has it", async () => {
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce({ mtime_ns: 1, size: 10 });
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 1, size: 10, server_seq: 5 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 1, size: 10, server_seq: 5 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("SANITY_POLL_MS is 30 s", () => {
    expect(SANITY_POLL_MS).toBe(30_000);
  });

  it("uses the default 30 s cadence when no interval is given", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMeta).toHaveBeenCalledTimes(1);

    fetchMeta.mockResolvedValueOnce(baseline);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SANITY_POLL_MS - 1);
    });
    expect(fetchMeta).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMeta).toHaveBeenCalledTimes(2);
  });

  it("checks at once on window focus after the baseline, with no interval elapsed", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    const next: FileMeta = { mtime_ns: 2, size: 10, server_seq: 2 };
    fetchMeta.mockResolvedValueOnce(next);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(next);
  });

  it("skips a fetch on visibilitychange while hidden, fetches once when visible", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    renderHook(() => useFileMetaPoll(true, fetchMeta, onChange, 100));
    await act(async () => {
      await Promise.resolve();
    });

    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(fetchMeta).toHaveBeenCalledTimes(1);

    visibilitySpy.mockReturnValue("visible");
    fetchMeta.mockResolvedValueOnce(baseline);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(fetchMeta).toHaveBeenCalledTimes(2);

    visibilitySpy.mockRestore();
  });

  it("does not fetch on a focus event after unmount", async () => {
    const baseline: FileMeta = { mtime_ns: 1, size: 10, server_seq: 1 };
    const fetchMeta = vi
      .fn<() => Promise<FileMeta>>()
      .mockResolvedValueOnce(baseline);
    const onChange = vi.fn();

    const { unmount } = renderHook(() =>
      useFileMetaPoll(true, fetchMeta, onChange, 100),
    );
    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    fetchMeta.mockResolvedValueOnce({ mtime_ns: 2, size: 10, server_seq: 2 });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchMeta).toHaveBeenCalledTimes(1);
  });
});
