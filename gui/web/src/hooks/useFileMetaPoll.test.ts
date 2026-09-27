import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMeta } from "./useFileMetaPoll";
import { useFileMetaPoll } from "./useFileMetaPoll";

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
});
